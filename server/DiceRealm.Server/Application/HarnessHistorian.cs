namespace DiceRealm.Server.Application;

public sealed record HarnessHistoryText(string Detailed, string Brief);

// Only closed, pre-authorized historical text enters this port. The caller owns range
// freezing, durable attempts and publication; the historian has no game tools or state.
public interface IHarnessHistorian
{
    bool Enabled { get; }
    string Identity { get; }
    IHarnessHistorian Capture();
    Task<HarnessHistoryText> Summarize(HarnessHistoryFragment[] sources, Func<CancellationToken, Task> authorize,
        string campaignId, CancellationToken ct, int toolContractVersion = 50);
}
