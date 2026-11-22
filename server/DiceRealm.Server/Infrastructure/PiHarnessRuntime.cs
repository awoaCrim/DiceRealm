using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;

namespace DiceRealm.Server.Infrastructure;

// Independent campaigns can wait on providers concurrently. Each leased process still
// executes one ordered conversation; cancellation never terminates another lease.
public sealed class PiHarnessRuntime : IHarnessRuntime, IDisposable
{
    private readonly PiHarnessProcess[] workers;
    private readonly ConcurrentStack<PiHarnessProcess> idle;
    private readonly SemaphoreSlim available = new(4, 4);

    public PiHarnessRuntime(IConfiguration configuration)
    {
        workers = Enumerable.Range(0, 4).Select(_ => new PiHarnessProcess(configuration)).ToArray();
        idle = new(workers); // LIFO reuses warm processes; unused workers never start Node.
    }

    public async Task Prepare(CancellationToken ct)
    {
        await available.WaitAsync(ct);
        if (!idle.TryPop(out var worker))
        {
            available.Release();
            throw new InvalidOperationException("Harness worker lease is missing.");
        }
        try { await worker.Prepare(ct); }
        finally { idle.Push(worker); available.Release(); }
    }

    public async Task<HarnessCompletion> Execute(HarnessExecution execution,
        Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct)
    {
        await available.WaitAsync(ct);
        if (!idle.TryPop(out var worker))
        {
            available.Release();
            throw new InvalidOperationException("Harness worker lease is missing.");
        }
        try { return await worker.Execute(execution, callback, ct); }
        finally { idle.Push(worker); available.Release(); }
    }

    // HarnessRunService drains active executions before disposing its runtime.
    public void Dispose()
    {
        foreach (var worker in workers) worker.Dispose();
        available.Dispose();
    }
}

// Credentials, game data paths and developer config are NOT inherited.
// A broken/cancelled execution is never automatically retried.
internal sealed class PiHarnessProcess(IConfiguration configuration) : IDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private Process? process;
    private BoundedLines? stdout;
    private Task? stderr;
    private const int LineLimit = 2 * 1024 * 1024;
    public async Task Prepare(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { await Start(ct); }
        catch { Kill(); throw; }
        finally { gate.Release(); }
    }
    public async Task<HarnessCompletion> Execute(HarnessExecution execution,
        Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await Start(ct);
            var child = process!;
            using var exited = new CancellationTokenSource();
            using var executionLifetime = CancellationTokenSource.CreateLinkedTokenSource(ct, exited.Token);
            var lifetime = executionLifetime.Token;
            void OnExit(object? sender, EventArgs args)
            {
                try { exited.Cancel(); }
                catch (ObjectDisposedException) { /* an already dispatched exit notification raced teardown */ }
                catch (AggregateException) { /* cancellation is signalled; provider callbacks must not escape the process event thread */ }
            }
            child.Exited += OnExit;
            try
            {
                child.EnableRaisingEvents = true;
                if (child.HasExited) OnExit(child, EventArgs.Empty); // also cover exit before event subscription
                lifetime.ThrowIfCancellationRequested();
                object frame = execution.ContextPolicy is null
                    ? new { type = "run", protocol = 1, execution.ExecutionId, execution.SystemPrompt, execution.Turns, execution.Tools, execution.Limits }
                    : new { type = "run", protocol = 1, execution.ExecutionId, execution.SystemPrompt, execution.Turns, execution.Tools, execution.Limits, execution.ContextPolicy };
                await Send(frame, lifetime);
                var callbackIds = new HashSet<string>(StringComparer.Ordinal);
                while (true)
                {
                    var item = await Receive(lifetime);
                    string type = item.GetProperty("type").GetString() ?? "";
                    if (item.GetProperty("executionId").GetString() != execution.ExecutionId) throw HarnessJson.Conflict("harness_wire_identity");
                    if (type == "request")
                    {
                        var call = new HarnessCallback(item.GetProperty("id").GetString()!, item.GetProperty("kind").GetString()!,
                            item.GetProperty("turn").GetInt32(), item.GetProperty("sequence").GetInt32(), item.GetProperty("payload").Clone());
                        if (!callbackIds.Add(call.Id)) throw HarnessJson.Conflict("harness_wire_duplicate");
                        // Observe the callback rather than abandoning it. Its owner bounds provider
                        // waiting with this token and preserves any committed domain receipt.
                        var result = await callback(call, lifetime);
                        await Send(new { type = "reply", execution.ExecutionId, call.Id, result }, lifetime);
                    }
                    else if (type == "complete")
                        return new(item.GetProperty("stopped").GetBoolean(), item.GetProperty("text").GetString()!,
                            item.GetProperty("modelCalls").GetInt32(), item.GetProperty("toolCalls").GetInt32());
                    else if (type == "error")
                        throw HarnessJson.Conflict(item.GetProperty("code").GetString() switch
                        {
                            "limit_model_calls" => "harness_model_limit", "limit_tool_calls" => "harness_tool_limit",
                            "limit_output_characters" => "harness_output_limit", "limit_context_bytes" => "harness_context_limit",
                            "limit_transport_bytes" => "harness_transport_limit",
                            "system_prompt_mismatch" => "harness_system_prompt_mismatch", "tool_declaration_mismatch" => "harness_tool_declaration_mismatch",
                            "model_reply_empty" or "model_reply_unknown_tool" or "invalid_reply" => "harness_model_output",
                            "invalid_frame" or "invalid_run" or "line_too_large" or "unsupported_protocol" => "harness_wire_invalid",
                            "cancelled" => "harness_cancelled", _ => "harness_runtime_failed"
                        }); // closed mapping, never echo arbitrary child-supplied text
                    else throw HarnessJson.Conflict("harness_wire_invalid");
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested && exited.IsCancellationRequested)
            {
                throw HarnessJson.Conflict(stdout?.HasPartialFrame is true ? "harness_wire_partial" : "harness_runtime_eof");
            }
            finally { child.Exited -= OnExit; }
        }
        catch { Kill(); throw; }
        finally { gate.Release(); }
    }
    private async Task Start(CancellationToken ct)
    {
        if (process is { HasExited: false }) return;
        Kill();
        string entry = configuration["Harness:AgentHostPath"] ?? "";
        if (string.IsNullOrWhiteSpace(entry) || !Path.IsPathFullyQualified(entry) || !File.Exists(entry) || Path.GetExtension(entry) != ".js")
            throw HarnessJson.Conflict("harness_runtime_unconfigured");
        var start = new ProcessStartInfo(configuration["Harness:NodeExecutable"] ?? "node")
        {
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true,
            RedirectStandardError = true, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(entry)!,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.ArgumentList.Add(entry);
        start.Environment.Clear();
        foreach (string name in new[] { "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP" })
            if (Environment.GetEnvironmentVariable(name) is { } value) start.Environment[name] = value;
        start.Environment["NODE_TLS_REJECT_UNAUTHORIZED"] = "1";
        start.Environment["NO_COLOR"] = "1";
        process = Process.Start(start) ?? throw HarnessJson.Conflict("harness_runtime_start");
        stdout = new(process.StandardOutput.BaseStream);
        stderr = Drain(process.StandardError); // never forward private SDK exceptions/body to logs
        using var startup = CancellationTokenSource.CreateLinkedTokenSource(ct);
        startup.CancelAfter(TimeSpan.FromSeconds(20));
        var ready = await Receive(startup.Token);
        if (ready.GetProperty("type").GetString() != "ready" || ready.GetProperty("protocol").GetInt32() != 1 ||
            ready.GetProperty("runtime").GetString() != "pi" || ready.GetProperty("version").GetString() != "0.87.1")
            throw HarnessJson.Conflict("harness_runtime_version");
    }
    private async Task Send<T>(T value, CancellationToken ct)
    {
        string line = HarnessJson.Serialize(value);
        if (Encoding.UTF8.GetByteCount(line) > LineLimit) throw HarnessJson.Conflict("harness_wire_limit");
        await process!.StandardInput.WriteLineAsync(line.AsMemory(), ct);
        await process.StandardInput.FlushAsync(ct);
    }
    private async Task<JsonElement> Receive(CancellationToken ct)
    {
        string line = await stdout!.Read(ct) ?? throw HarnessJson.Conflict("harness_runtime_eof");
        using var json = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 48 });
        HarnessJson.Validate(json.RootElement); return json.RootElement.Clone();
    }
    private static async Task Drain(StreamReader reader)
    {
        try { var buffer = new char[4096]; while (await reader.ReadAsync(buffer) > 0) { } }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException) { /* owned process teardown */ }
    }
    private void Kill()
    {
        if (process is null) return;
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { /* already exited */ }
        finally { process.Dispose(); process = null; stdout = null; stderr = null; }
    }
    public void Dispose() { Kill(); gate.Dispose(); }
    private sealed class BoundedLines(Stream stream)
    {
        private static readonly UTF8Encoding Utf8 = new(false, true);
        private readonly byte[] buffer = new byte[4096];
        private int position, count;
        public bool HasPartialFrame { get; private set; }
        public async Task<string?> Read(CancellationToken ct)
        {
            using var line = new MemoryStream();
            while (true)
            {
                if (position == count)
                {
                    // StreamReader.ReadAsync may try to fill its character buffer even
                    // after a complete line arrived on an idle pipe. Frame raw bytes first.
                    count = await stream.ReadAsync(buffer.AsMemory(), ct); position = 0;
                    if (count == 0) return line.Length == 0 ? null : throw HarnessJson.Conflict("harness_wire_partial");
                }
                int newline = Array.IndexOf(buffer, (byte)'\n', position, count - position);
                int end = newline < 0 ? count : newline;
                int length = end - position;
                if (line.Length + length > LineLimit) throw HarnessJson.Conflict("harness_wire_limit");
                line.Write(buffer, position, length);
                HasPartialFrame = line.Length > 0;
                position = newline < 0 ? count : newline + 1;
                if (newline < 0) continue;
                HasPartialFrame = false;
                try { return Utf8.GetString(line.GetBuffer(), 0, checked((int)line.Length)); }
                catch (DecoderFallbackException) { throw HarnessJson.Conflict("harness_wire_invalid"); }
            }
        }
    }
}
