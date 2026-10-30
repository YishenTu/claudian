/** Constant command bundled with the plugin. No route data is interpolated. */
export const SESSION_TOOL_RELAY_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -ReferencedAssemblies 'System.dll','System.Core.dll','System.Net.Http.dll','System.Web.Extensions.dll' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class ClaudianSessionToolRelay {
  public static int Run() {
    var mode = Environment.GetEnvironmentVariable("CLAUDIAN_SESSION_TOOL_MODE");
    if (mode == "probe") { Console.WriteLine("claudian-relay-ready"); return 0; }
    var url = new Uri(Environment.GetEnvironmentVariable("CLAUDIAN_SESSION_TOOL_URL"));
    if ((mode != "mcp" && mode != "call") || url.Scheme != "http" || url.Host != "127.0.0.1"
        || url.AbsolutePath != "/" + mode || url.Query != "" || url.Fragment != "" || url.UserInfo != "")
      return 1;
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    // .NET Framework otherwise queues requests behind two connections, preventing
    // cancellation notifications from reaching the endpoint during slow calls.
    ServicePointManager.DefaultConnectionLimit = Int32.MaxValue;
    using (var stop = new CancellationTokenSource())
    using (var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
    using (var client = new HttpClient(handler)) {
      client.Timeout = Timeout.InfiniteTimeSpan;
      client.DefaultRequestHeaders.Add("X-Claudian-Route", Environment.GetEnvironmentVariable("CLAUDIAN_SESSION_TOOL_ROUTE"));
      var failed = new TaskCompletionSource<bool>();
      var completed = new TaskCompletionSource<bool>();
      var outputLock = new object();
      var pending = new Dictionary<string, CancellationTokenSource>();
      var input = Task.Run(() => {
        string line;
        bool sent = false;
        while ((line = Console.ReadLine()) != null) {
          if (mode == "call" && sent) { failed.TrySetResult(true); break; }
          sent = true;
          var message = ReadMessage(line);
          object method;
          string requestKey = null;
          if (mode == "mcp" && message != null && message.TryGetValue("method", out method)) {
            object id;
            if (Equals(method, "tools/call") && message.TryGetValue("id", out id)) requestKey = RequestKey(id);
            object parameters;
            if (Equals(method, "notifications/cancelled") && message.TryGetValue("params", out parameters)) {
              var values = parameters as Dictionary<string, object>;
              object cancelledId;
              var key = values != null && values.TryGetValue("requestId", out cancelledId) ? RequestKey(cancelledId) : null;
              // A small cancellation HTTP body can overtake its call body. Abort
              // that call locally as well; endpoint policy still owns execution.
              lock (pending) {
                CancellationTokenSource request;
                if (key != null && pending.TryGetValue(key, out request)) request.Cancel();
              }
            }
          }
          var requestStop = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
          lock (pending) {
            if (requestKey != null && !pending.ContainsKey(requestKey)) pending.Add(requestKey, requestStop);
          }
          Action detach = () => {
            lock (pending) {
              CancellationTokenSource current;
              if (requestKey != null && pending.TryGetValue(requestKey, out current) && current == requestStop) pending.Remove(requestKey);
            }
          };
          // Register before starting HTTP so even the next stdin line can cancel it.
          Send(client, url, line, mode, requestStop, outputLock, failed, completed, detach);
        }
      });
      Task.WaitAny(input, failed.Task, completed.Task);
      stop.Cancel();
      client.CancelPendingRequests();
      if (failed.Task.IsCompleted || input.IsFaulted) {
        Console.Error.WriteLine("Session tool relay request failed.");
        return 1;
      }
      return 0;
    }
  }

  private static async void Send(HttpClient client, Uri url, string line, string mode,
      CancellationTokenSource requestStop, object outputLock, TaskCompletionSource<bool> failed,
      TaskCompletionSource<bool> completed, Action detach) {
    var stop = requestStop.Token;
    try {
      using (var content = new StringContent(line, Encoding.UTF8, "application/json"))
      using (var response = await client.PostAsync(url, content, stop).ConfigureAwait(false)) {
        if (!response.IsSuccessStatusCode) { failed.TrySetResult(true); return; }
        if (response.StatusCode != HttpStatusCode.Accepted) {
          var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
          detach();
          lock (outputLock) {
            if (!stop.IsCancellationRequested) { Console.WriteLine(body); Console.Out.Flush(); }
          }
        }
        if (mode == "call") completed.TrySetResult(true);
      }
    } catch (OperationCanceledException) {
      if (!stop.IsCancellationRequested) failed.TrySetResult(true);
    } catch { failed.TrySetResult(true); }
    finally { detach(); requestStop.Dispose(); }
  }

  private static Dictionary<string, object> ReadMessage(string line) {
    try { return new JavaScriptSerializer().DeserializeObject(line) as Dictionary<string, object>; }
    catch { return null; }
  }

  private static string RequestKey(object id) {
    if (id is string) return "s:" + (string)id;
    if (id is int || id is long || id is decimal || id is double)
      return "n:" + Convert.ToDouble(id).ToString("R", CultureInfo.InvariantCulture);
    return null;
  }
}
'@
exit ([ClaudianSessionToolRelay]::Run())
} catch {
  [Console]::Error.WriteLine('Windows PowerShell could not start the session tool relay.')
  exit 1
}
`;
