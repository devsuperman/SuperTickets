using Amazon.CDK;
using SuperTickets.Cdk;

var app = new App();

var data = new DataStack(app, "SuperTickets-Data");
var messaging = new MessagingStack(app, "SuperTickets-Messaging");

// T13 (ServicesStack), T14 (WebStack) and T15 (ApiStack) append their stacks below.

app.Synth();
