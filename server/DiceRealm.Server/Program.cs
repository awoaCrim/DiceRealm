using DiceRealm.Server.Api;

if (RuntimeCommands.Execute(args, Console.Out, Console.Error) is int result) return result;
var app = DiceRealmHost.Build(args);
await app.RunAsync();
return 0;
