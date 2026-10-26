# Your API, your files

The viewing app only reads. A separate tool that you own can create the content.

1. Your API, agent, or script produces a result.
2. It writes a Markdown, text, or JSON file inside the workspace.
3. It optionally updates a collection's `index.json` with a link to the result.
4. The active browser picks up the change on its next refresh.

When writing from a script, write to a temporary file and rename it into place. This helps the viewer avoid reading a JSON document halfway through an update.

There is no required model provider or agent framework. You decide what creates the files.
