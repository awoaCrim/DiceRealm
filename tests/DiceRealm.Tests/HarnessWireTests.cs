using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;

namespace DiceRealm.Tests;

internal static class HarnessWireTests
{
    // A real idle Node pipe, deliberately not the Pi SDK: transport framing must not
    // require the child to send another byte after a newline at a read-buffer boundary.
    public static async Task ExactBlockLinesAndUtf8Boundaries()
    {
        string directory = Path.Combine(Path.GetTempPath(), "dicerealm-wire-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        string entry = Path.Combine(directory, "wire-fixture.js");
        await File.WriteAllTextAsync(entry, """
            const readline = require('node:readline');
            process.stdout.write(JSON.stringify({type:'ready',protocol:1,runtime:'pi',version:'0.87.1'})+'\n');
            readline.createInterface({input:process.stdin}).on('line', line => {
              const run = JSON.parse(line);
              if (run.type !== 'run') return;
              const mode = run.turns[0];
              if (mode === 'partial') { process.stdout.write('{"type":'); return; }
              if (mode === 'oversize') { process.stdout.write('x'.repeat(2*1024*1024+1)+'\n'); return; }
              if (mode === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff,0x0a])); return; }
              const [size, split] = mode.split(':').map(Number);
              const frame = {type:'complete',executionId:run.executionId,stopped:false,text:'中😀',modelCalls:0,toolCalls:0};
              frame.text += 'x'.repeat(size-Buffer.byteLength(JSON.stringify(frame)+'\n'));
              const bytes = Buffer.from(JSON.stringify(frame)+'\n');
              if (bytes.length !== size) throw new Error('fixture frame size mismatch');
              if (split) {
                const cut = bytes.indexOf(Buffer.from('😀'))+1;
                process.stdout.write(bytes.subarray(0,cut));
                setImmediate(() => process.stdout.write(bytes.subarray(cut)));
              } else process.stdout.write(bytes);
            });
            """);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Harness:AgentHostPath"] = entry
        }).Build();
        try
        {
            using var runtime = new PiHarnessRuntime(configuration);
            int callbacks = 0;
            Task<JsonElement> Callback(HarnessCallback call, CancellationToken token)
            {
                callbacks++;
                throw new InvalidOperationException("Wire-only fixture must not invoke any model or tool.");
            }
            foreach (int size in new[] { 4095, 4096, 4097, 8192, 16384 })
                foreach (int split in new[] { 0, 1 })
                {
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    var result = await runtime.Execute(new(Guid.NewGuid().ToString(), "", [$"{size}:{split}"], [], new()), Callback, deadline.Token);
                    Check.True(result.Text.StartsWith("中😀", StringComparison.Ordinal));
                    Check.Equal(0, result.ModelCalls); Check.Equal(0, result.ToolCalls);
                }
            // Prove bytes were accepted before killing this fixture's owned child.
            // Immediate exit would race pipe delivery and cannot distinguish empty EOF.
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
            {
                var execution = runtime.Execute(new(Guid.NewGuid().ToString(), "", ["partial"], [], new()), Callback, deadline.Token);
                while (!HasPartialFrame(runtime)) await Task.Delay(10, deadline.Token);
                var child = HarnessPiIsolationTests.ManagedChild(runtime);
                child.Kill(entireProcessTree: true);
                try { await execution; throw new Exception("Expected partial frame rejection"); }
                catch (GameException error) { Check.Equal("harness_wire_partial", error.Code); }
            }
            foreach (var (mode, code) in new[] { ("oversize", "harness_wire_limit"), ("invalid-utf8", "harness_wire_invalid") })
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try
                {
                    await runtime.Execute(new(Guid.NewGuid().ToString(), "", [mode], [], new()), Callback, deadline.Token);
                    throw new Exception("Expected wire rejection " + code);
                }
                catch (GameException error) { Check.Equal(code, error.Code); }
            }
            Check.Equal(0, callbacks);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
    private static bool HasPartialFrame(PiHarnessRuntime runtime)
    {
        return HarnessPiIsolationTests.Workers(runtime).Any(worker =>
        {
            var reader = worker.GetType().GetField("stdout", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(worker);
            return reader?.GetType().GetProperty("HasPartialFrame")?.GetValue(reader) is true;
        });
    }
}
