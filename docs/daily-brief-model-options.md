# Daily brief model options

Research checked on October 2, 2026. This note records a possible extension;
this release keeps the existing deterministic brief and enables no inference
credentials, billing, or new scheduled jobs.

## OpenAI access

The standard OpenAI API charges for model input and output. The current
cost-sensitive GPT-5.6 Luna model explicitly lists the Free tier as unsupported.
No documented permanent free public text-generation allowance was found that
this hosted Site could rely on for unattended daily summaries.

Official sources:

- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-5.6-luna

OpenAI also documents Sign in with ChatGPT plan usage: an authorized open-source
or locally hosted application can use eligible Responses API requests against
the signed-in user's ChatGPT plan. The documentation directs paid or remotely
hosted applications to an interest form. This is a separate, account-authorized
path with account-specific usage limits, rather than a free API key for this
remotely hosted Site. A locally scheduled publisher could be explored separately
if the owner wishes to use existing plan allowance; it would depend on that
machine remaining available and on the documented authorization and limits.

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

## Generate once, serve everyone

A server-side job can generate one summary for each `America/Chicago` local date,
at approximately 05:00, after a successful source refresh. Every visitor then
reads the same durable result. Visitor requests must never trigger inference.
The existing in-process content-hash cache is not sufficient for sharing one
model response across Worker instances or restarts.

A proposed D1 row has a unique local-date key and stores the text, generation
instant, source-content hash, model, and prompt version. A durable lease prevents
overlapping jobs from calling the model simultaneously. Once a successful row
exists, later invocations skip generation. An unsuccessful attempt can retry
within a bounded limit and leave the deterministic summary available.

The model should receive structured published events and produce a short summary
containing only supported times, venues, food descriptions, restrictions, and
cancellations. Validate its output and retain the corresponding event links.
Display when it was generated. Event cards continue to show current information
when the source changes after the morning summary was cached.

A schedule must account for daylight saving time: 05:00 in Chicago corresponds
to different UTC times during the year. GitHub Actions cron dispatch can be late,
so it cannot guarantee execution at exactly 05:00. See
https://docs.github.com/en/actions/how-tos/troubleshoot-workflows. A timezone-aware scheduler,
or UTC triggers with a Chicago-time guard and a recovery run, can implement this
once-per-local-date behavior. No schedule has been changed by this research.
