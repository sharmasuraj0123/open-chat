# Design notes

## The brief

Build a Next.js app that resembles OpenMuse while presenting a read-only mirror of a local directory. Interaction means opening folders and files. Content changes happen on disk.

## Visual reference

OpenMuse uses a narrow, centered workspace on an almost-white canvas. A small mascot and status line anchor the header. Rounded cards, pale blue chat bubbles, understated typography, and an icon dock give the interface its character.

The reference source is CopilotKit's OpenMuse repository, especially `apps/mobile/App.tsx` for the shell and `apps/mobile/src/ui.tsx` for the shared styles. The app uses those visual ideas in standard Next.js components.

## Filesystem behavior

- Top-level directories supply the dock.
- Nested directories preserve their hierarchy.
- Selecting a file loads its actual saved contents.
- Conversation and collection JSON provide optional richer views.
- Ordinary JSON, Markdown, CSV, and text remain useful without conversion.
- Changes are observed through regular reads while the browser is active.

## Product boundary

This is a viewer. A separate process can write results into the workspace, including responses from an API you own. The viewer does not need to know which tool produced a file.
