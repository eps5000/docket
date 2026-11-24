# Onboarding a project

**Read when:** The owner asks you to set up a project or onboard a repo into one.
**Don't read when:** The project is already onboarded and you're dispatching work.

1. **If the project has Jira tickets,** ask the owner to run the Jira import first (Settings → Projects). Onboarding then enriches those tickets instead of duplicating them.
2. **Call `onboard_project { key, name }`.** It creates the project (`name` is needed then) or adopts the existing one, and returns a `session_id`, what the project already holds, and the guide. Follow the guide step by step; it needs no installed files.
3. **Do it in one session, as one client.** Another agent's `onboard_project` on the same project is refused while yours is in progress. Your own reconnect gets the same session back. Subagents may read the repo, but you make the Docket calls.
4. **Nothing goes to Ready.** Everything stays in Inbox or Planning; `set_status` "ready" is refused until you finish. Don't dispatch workers on it: the owner reviews first.
5. **Finish with `finish_onboarding { session_id, summary, questions }`,** then stop. The owner reviews it all from one card, approves the Workflow notes and installs the agent files. Running it again later is safe: the guide matches what's already there.
