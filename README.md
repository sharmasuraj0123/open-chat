# Muse Mirror

A Next.js app that follows OpenMuse's visual design and mirrors a local directory. Top-level folders become dock items. Browse nested folders, open documents, and read conversations or collections stored as JSON.

The filesystem is the source of truth. The interface reads content; you make changes in your editor or with scripts and APIs you control. No model API key, database, hosted agent runtime, or cloud service is required.

## Run locally

From this directory:

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3210](http://127.0.0.1:3210). The local server binds to `127.0.0.1`.

You can also use the included launcher: `./start-local.ps1` in PowerShell or `sh start-local.sh` in a shell.

The default content directory is `./workspace`, which includes five example folders and a home conversation. To mirror another directory, create `.env.local` in the app directory:

```dotenv
MIRROR_ROOT=/absolute/path/to/your/content
```

Use a directory whose contents you intend to browse. Restart the server after changing `MIRROR_ROOT`.

## How it works

- Top-level folders determine the dock; folder names are read from disk.
- Folder navigation preserves the real directory hierarchy.
- Opening a file reads its saved contents directly through the local server.
- The first visit opens the root `index.json` automatically when present.
- Opening a folder browses its files. If it contains `index.json`, an “Open …” card opens that richer conversation or collection view.
- The active browser checks for disk changes every 1.5 seconds.
- Content endpoints are read-only `GET` routes. The app has no content-write endpoint.

Names starting with `.` and `node_modules` are excluded from browsing and cannot be opened through the content endpoints. Ordinary folders such as `dist` remain visible. The backend enforces the configured root boundary for file reads: internal symlinks work, while symlinks that escape the root or resolve to hidden paths are excluded.

Text previews are limited to 2 MB, image and PDF previews to 20 MB, and directory listings to 2,000 visible entries. The app reports an explicit error when a limit is exceeded.

Try editing `workspace/index.json` and saving it. Then add a folder directly inside `workspace` to add another dock item. To have your own API produce content, write its results into this directory; the viewer will pick them up.

## Optional JSON presentations

Ordinary JSON works without a schema. It is shown as inspectable data, with its raw source available. These two optional shapes add conversation and collection presentations. Link paths are relative to the workspace root, with `/` between folder names.

### A saved conversation

```json
{
  "type": "conversation",
  "title": "Project notes",
  "subtitle": "Saved on disk",
  "messages": [
    {
      "role": "user",
      "content": "Where is the brief?"
    },
    {
      "role": "assistant",
      "content": "It lives in the Notes folder.",
      "links": [{ "label": "Read the brief", "path": "Notes/brief.md" }]
    }
  ]
}
```

Message roles are `user`, `assistant`, or `system`. A message may also have a `time` string. Messages are saved content; opening the file does not call a model.

### A collection

```json
{
  "type": "collection",
  "title": "Research",
  "subtitle": "A few useful documents",
  "items": [
    {
      "title": "Design brief",
      "description": "The current workspace direction.",
      "status": "Saved",
      "category": "Notes",
      "path": "Notes/brief.md",
      "meta": "Markdown"
    }
  ]
}
```

Collection items require a `title`; the other illustrated properties are optional. An item can also include a numeric `progress` value for saved progress information. `path` may point to a file or a folder.

The sample content also includes nested Markdown, ordinary JSON, CSV, and plain text. These files demonstrate navigation and rendering without imposing a storage format on your own content.

## Development checks

```bash
npm run typecheck
npm test
npm run build
```

Verified locally: TypeScript checks, all 12 filesystem/API tests, and the Next.js production build pass. The development page and example-workspace API return HTTP 200. Laptop layouts use a 960px maximum width; mobile retains the compact layout. Exact visual parity with upstream has not been independently verified. Production builds currently report dynamic-filesystem tracing warnings because MIRROR_ROOT is resolved at runtime; run this app as a local Node service with access to your content directory.

## Visual attribution

The layout and visual styles are ported from [CopilotKit/OpenMuse](https://github.com/CopilotKit/OpenMuse), especially `apps/mobile/App.tsx` and `apps/mobile/src/ui.tsx`, into Next.js. The upstream MIT notice is retained in `OPENMUSE-LICENSE`. This viewer uses its own filesystem data layer.
