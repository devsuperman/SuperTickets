using SuperTickets.Shared;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSuperTicketsDefaults();

var app = builder.Build();
app.UseSuperTicketsDefaults();
app.Run();

public partial class Program;
