using SuperTickets.Shared;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddSuperTicketsDefaults();

var host = builder.Build();
host.Run();
