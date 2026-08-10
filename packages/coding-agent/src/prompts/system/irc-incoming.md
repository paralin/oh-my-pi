<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (replying to {{replyTo}}){{/if}}:

{{message}}

{{#if interrupting}}An agent sent this while you were waiting or working. Any active interruptible wait was stopped early so you can read it now.{{/if}}

{{#if autoReplied}}You are mid-task, so a side-channel auto-reply was generated from your context and delivered to `{{from}}` on your behalf (recorded after this message). Use `await agent_message.list_agents()` to identify the sender's family role, then reply through `agent_message.send` only if that auto-reply needs correcting.{{else}}If a response is expected, use `await agent_message.list_agents()` to identify the sender's family role, then reply through `agent_message.send` — you may finish your current step first. Nobody replies on your behalf.{{/if}}
</irc>
