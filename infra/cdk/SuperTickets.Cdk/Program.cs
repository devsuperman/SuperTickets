using Amazon.CDK;
using SuperTickets.Cdk;

var app = new App();

var data = new DataStack(app, "SuperTickets-Data");
var messaging = new MessagingStack(app, "SuperTickets-Messaging");

var services = new ServicesStack(app, "SuperTickets-Services", new ServicesStackProps { Data = data, Messaging = messaging });

// T14 (WebStack) and T15 (ApiStack) append their stacks below.

// T14: API origin is a placeholder until T15 (ApiStack) passes its real domain.
_ = new WebStack(app, "SuperTickets-Web", new WebStackProps { ApiOriginDomain = "api-placeholder.example.com" });

app.Synth();
