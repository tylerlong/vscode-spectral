Here are certain parts of code used in Studio needed to make the Spectral integration happen.
The linting happens in the worker thread, while the main thread instruments the "backend" which document to lint and consumes the errors.
I removed most of the irrelevant Studio logic, such as messaging, listening to UI events, consuming errors, etc.
There are still some processes that are unavoidable, such as: 
- loading a ruleset from the fs
- validating the ruleset (and optionally displaying any errors if the ruleset is invalid)
- reloading the ruleset if the contents changes
- listening to the document change
- listening to active document change

The initialization process of Spectral is likely to be fairly similar either.
All known formats will need to be registered, static assets should be provided as well.
You may want to use a custom json-ref-resolver instance depending on how VSCode handles requests and supports FS.
