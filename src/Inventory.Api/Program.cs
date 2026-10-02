using Inventory.Api.Common;
using Inventory.Api.Features.GetAvailability;
using Inventory.Api.Features.ReleaseReservation;
using Inventory.Api.Features.ReserveStock;
using Inventory.Api.Features.SetCapacity;
using Npgsql;
using SuperTickets.Shared;

var builder = WebApplication.CreateBuilder(args);
var connectionString = builder.Configuration.GetConnectionString("Inventory")
    ?? throw new InvalidOperationException("ConnectionStrings:Inventory is required.");

builder.Services.AddSuperTicketsDefaults();
builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(connectionString));
builder.Services.Configure<DemoOptions>(builder.Configuration.GetSection("Demo"));
builder.Services.AddHealthChecks().AddCheck<PostgresHealthCheck>("postgres");

var app = builder.Build();

await Database.MigrateAsync(connectionString);

app.UseSuperTicketsDefaults();
GetAvailability.Map(app);
SetCapacity.Map(app);
ReserveStock.Map(app);
ReleaseReservation.Map(app);
app.Run();

public partial class Program;
