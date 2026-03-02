# Session Context

## User Prompts

### Prompt 1

resume

### Prompt 2

Let's work on creating overviews of groups of events. SessionStart will be the start of a group, and Stop is the end of the group. Create a function that automatically takes a group of events, then creates an overview. This overview should live in a new table called InteractionOverview, with a summary field, a keywords field, started_at field, ended_at field, and sessionId field to link it to the session it came from. Every time a new group is written to the database, we should call this func...

### Prompt 3

let's call the backfill-overviews subcommand. We also need to show the overviews in the UI.

### Prompt 4

do i have to restart the server for the overview changes to show up?

### Prompt 5

restart the server

### Prompt 6

Markdown is still not being rendered correctly. For examples, on some of the assistant events, i see what are supposed to be markdown tables but i see the raw text of the markdown, not a table.

