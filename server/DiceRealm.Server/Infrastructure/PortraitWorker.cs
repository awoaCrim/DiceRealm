using DiceRealm.Server.Application;

namespace DiceRealm.Server.Infrastructure;

public sealed class PortraitWorker(PortraitCatalog catalog, IMapImageGenerator generator,
    ILogger<PortraitWorker> logger, IConfiguration configuration) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var job = catalog.Claim();
                if (job is null) { await Task.Delay(500, stoppingToken); continue; }
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                    timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue("ImageAi:TimeoutSeconds", 180), 15, 300)));
                    var png = await generator.Generate(job.Request, timeout.Token).WaitAsync(timeout.Token);
                    catalog.Complete(job, png);
                }
                catch (OperationCanceledException)
                {
                    catalog.Fail(job, "portrait_generation_unconfirmed", unknown: true);
                    if (stoppingToken.IsCancellationRequested) return;
                }
                catch (ProviderQuotaException) { catalog.Fail(job, "image_quota_exceeded"); }
                catch (ImageGenerationException ex) { catalog.Fail(job, ex.Code); }
                catch (NotSupportedException) { catalog.Fail(job, "portrait_provider_unsupported"); }
                catch (Exception ex)
                {
                    logger.LogWarning("Portrait generation unconfirmed ({ErrorType}), portrait {PortraitId}", ex.GetType().Name, job.Id);
                    catalog.Fail(job, "portrait_generation_unconfirmed", unknown: true);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                logger.LogError("Portrait queue iteration failed ({ErrorType})", ex.GetType().Name);
                // Only wait for storage recovery. A generating/unknown task is never reclaimed.
                try { await Task.Delay(1000, stoppingToken); }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            }
        }
    }
}
