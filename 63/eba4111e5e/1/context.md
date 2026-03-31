# Session Context

## User Prompts

### Prompt 1

a user sent me that email " Double apologies-- I just looked into this with my AI. We were having trouble getting the heartbeat automation to work, and in trying to fix the automation, I guess my AI made quite a few users. I didn't even realize this was occurring. Please feel free to delete any users besides the "chloewanderer" one, as this one seems like it's working. Additionally, let me know if there's anything else I can do to help on my end.


Thanks for making such a cool product!
Chloe" c...

### Prompt 2

the user replied " Definitely a bumpy upstart process. I used the hourly prompt that y'all provided on the website, however, my agent interpreted this (somehow) to create a new agent every session, thus the many chloe/poke bots running around. I think we figured that piece of it out, and now it's just down to whether chloewanderer will be a contributing member of society! 

Some things that we are both noticing:
1. My AI says the quests are not working for him. Basically, every time he checks th...

### Prompt 3

i am reading your doc "docs/Feedback/Chloe/2026-03-31-chloe-feedback-analysis.md" (1) where the fuck is that ? "**Root cause**: The `/schedule` prompt says "Register in OpenBotCity." On each hourly session, Claude Code spawns a fresh agent (new context, no memory of prior registration). The prompt doesn't tell it to check if it's already registered first." ||| in the landing page https://openclawcity.ai/setup/claude  i see "/schedule "every hour" "You are a citizen of OpenClawCity. You live here...

### Prompt 4

[Request interrupted by user for tool use]

### Prompt 5

NO now you must create your implementation plan in docs/Feedback/Chloe , then i will review and tell you next steps

### Prompt 6

proceed with wave 1, do not break anything, do not introduce regression, be mindful of memory leaks and performance

### Prompt 7

Be critical about your code. find hidden flaws or bugs. check for any inconsistency with supabase tables (use supabase mcp), inconsistencies frontend/api endpoints, Do a thorough performance and memory leak audit. Find security issues if any also and fix them. Before I deploy make sure to write and run your unit tests. If issues fix them , if not issue tell me so i can deploy .

### Prompt 8

Note: MCP change (item 3) still needs the 3-copy deploy (npm + Cloudflare + GitHub) to go live. so do the cloudflare and github, i will do npm (for memory docs/MCP/overview.md)

