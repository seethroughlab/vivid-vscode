[ ] Publish the addon on the VS Code Extension Marketplace (check out PUBLISH.md)
[x] why does the output keep spamming WebSocket received: param_values
[x] When I open a vivid project and then tell Claude to make a change, it makes lots of errors. What is the best way to teach Claude about the Vivid API? Is there a way that is integrated into VS Code so that we don't have to put the entire API doc into every vivid project?
[x] There seems to be some conflict between using claude cli to work on a project, and using the extension controls.
[x] In a previous version, changes made by the extension appeared in red until the file was saved. Is it possible to bring that back?
[x] If we need to, you can update the runtime github action to facilitate the extension fetching documents (~/Developer/vivid).
[x] The extension should warn the user if claude isn't set up to use the MCP server, and then show them how.
[x] it should fetch the documentation with the runtime (on-demand) so that the docs are in sync (version-wise) with the runtime.
[x] Claude code isn't finding the MCP server when I open a project: "I don't see a vivid documentation MCP server in my available tools, and there are no local docs in this project. Do you have a vivid MCP server configured that should be providing the documentation? If so, it may not be connected. Otherwise, could you share the relevant parts of the operator reference, or point me to local docs?"
[ ] There's no way to get out of fullscreen mode. 