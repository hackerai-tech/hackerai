# Fin-Managed Content

This folder syncs Markdown files into Fin. 

## Frontmatter schema

Frontmatter schema is OPTIONAL, but allows users to customise certain settings when articles are synced to Fin. Below table lists all currently allowed keys and values. 

| Key | Allowed values | Description |
|---|---|---|
| title | Any text | Specify the title of your article. If not present we will find the first H1 or humanize the markdown file name. |
| description | Any text | Short description that appears underneath the title of an article in Fin |
| published / state | `published` / `true` / `draft` / `false` | Specify whether the article gets synced as published or draft |
| service_agent / service | `enabled` / `disabled` | Specify if article is accessible to Fin AI Agent |
| copilot | `enabled` / `disabled` | Specify if article is accessible to Fin Copilot |
| sales_agent / sales | `enabled` / `disabled` | Specify if article is accessible to Fin Sales Agent |

## How to add new content

### A new article

1. Pick (or create) a new markdown file in the managed directory.
2. Commit and open a PR.

## How to update or delete content

1. Update or delete the markdown file as required.
2. Commit and open a PR.

## Known limitations

* Only sync Markdown (.md) files. .mdx files are supported on request — ask Intercom to enable them for your workspace. Components we cannot represent are dropped from the synced article, and an .mdx article cannot be edited in Intercom.
* Synced articles as disabled for AI Agent/Copilot/Sales Agent by default to allow you to manually review these before setting them live.
* This is a one-way sync only, from GitHub to Fin. Articles currently must be edited in GitHub.
