# Welcome to Muse Mirror

A little room for your files.

Muse Mirror displays the contents of a local directory. The interface follows OpenMuse's centered layout, soft cards, and floating dock. Content stays in files you control.

## Find your way around

Every visible top-level folder has a place in the dock. Open a folder to browse its files and nested folders. An `index.json` can give that folder a conversation or collection view.

The sample workspace includes Chat, Activity, Ideas, Goals, and Files. Their contents are saved examples, not a running agent.

## Change the workspace

1. Open `workspace/index.json` in your editor.
2. Change a message and save the file.
3. Return to the app's home view. The active browser checks for changes every 1.5 seconds.

To add a dock item, create a folder directly inside the workspace. To add a document, save a Markdown, text, CSV, or JSON file in any visible folder. Renaming or removing a file on disk is reflected in the app too.

## Keep ordinary files ordinary

JSON has two optional display shapes: `conversation` for messages and `collection` for cards. Other JSON remains inspectable as data. The raw source is available so you can see what was actually saved.

You can browse these examples:

- `Chat/Examples/files-as-responses.json` — a saved conversation.
- `Ideas/index.json` — a collection of linked cards.
- `Files/Notes/Design.md` — a nested Markdown document.
- `Files/workspace.json` — ordinary nested JSON.
- `Files/content-inventory.csv` — a CSV file.

## Bring your own tools

The app reads local files; it does not send prompts or write content. Your own API, script, or editor can create and update the files it displays. No model key, database, or cloud service is required.
