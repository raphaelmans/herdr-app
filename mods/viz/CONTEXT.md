# Artifacts

Agents in Herdr produce artifacts: standalone documents that sit beside the agent's terminal and that the person can come back to later.

## Language

### The document

**Artifact**:
A standalone document an agent produces, like a Confluence page: prose plus any number of embeds. It is the only unit agents produce, and it belongs to a project, not to the agent that made it.
_Avoid_: visual, visual reply, card, page, file

**Prose**:
Everything in an artifact that markdown draws itself: headings, text, lists, tables and code blocks.
_Avoid_: text embed, body

**Embed**:
A non-text component inside an artifact: a diagram, a chart, an image or a page preview. It exists only as part of one artifact.
_Avoid_: component, visual, block, artifact (for a single piece)

**Diagram**:
An embed drawn from a text description of nodes and links, such as a flowchart or a sequence.
_Avoid_: graph, chart

**Chart**:
An embed that plots data.
_Avoid_: graph, plot, diagram

**Image**:
An embed that is a picture: a screenshot or a photo.
_Avoid_: asset, figure

**Page preview**:
An embed showing a snapshot of a rich web page, which can also be opened live.
_Avoid_: HTML embed, screenshot, iframe

**Block**:
The smallest piece of an artifact that can be picked: one heading, paragraph, list item, table, quote, code block or embed.
_Avoid_: part, segment, line, section

### Where artifacts live

**Project**:
Where an artifact belongs: the git root of the agent's working directory, else that directory itself. Artifacts made anywhere inside one repo share a project.
_Avoid_: folder, workspace, space (a Herdr space is something else)

**Library**:
Every artifact across all projects, archived ones included.
_Avoid_: artifacts (for the collection), gallery, history

**Archived**:
The state of an artifact that is put away from the library's normal view but kept, and can be restored.
_Avoid_: hidden, deleted, closed

### What happens to them

**Publish**:
An agent creating an artifact or replacing an existing one's content. Replacing overwrites: an artifact has no history. Any agent in the project can publish to any of its artifacts.
_Avoid_: post, upload, revision, version

**Artifact pane**:
A pane beside an agent that shows exactly one artifact: the one that agent published to most recently.
_Avoid_: Visuals pane, feed

**Annotation**:
A comment the person attaches to one block, or a run of blocks, of an artifact for its agent to act on. It is kept with the artifact until that artifact is published again.
_Avoid_: comment (for the whole thing: the comment is its text), note, review, citation

**Send**:
Giving every annotation not yet sent to the agent beside the artifact pane, as one message. Sent annotations stay in view, marked sent.
_Avoid_: submit, post, publish (that is the agent's act)
