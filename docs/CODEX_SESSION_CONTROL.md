# Codex mobile session control

Codex permits one active writer for a conversation. Reading its history and saving a draft do not establish that the phone can send a new task. Pocket Bridge therefore shows viewing and sending as separate states.

When another Codex instance owns the writer, the phone can continue in an independent copy or start a separate conversation in the same project. Pocket Bridge does not close a desktop process whose ownership it cannot verify.

The experimental **Send through desktop Codex** option offers another route for the original conversation: the verified desktop app remains the writer and submits plain text through its normal composer. The bridge checks the exact conversation UUID and canonical project directory. This does not release a lock, close desktop Codex or promise immediate execution; a running target may queue the message. The desktop's model and mode apply, and attachments, approvals and questions are not forwarded through this text route. Leave the computer unused during native phone actions. Existing desktop drafts are preserved, and an unknown result must be checked rather than resent. See the exact operated cases and remaining limits in [Desktop relay acceptance](desktop-relay-experimental.md).

## Returning control to the computer

The explicit handback action checks for running work, pending approvals or questions, queued messages, and unresolved control requests before proceeding. It cancels the subscription on the phone's actual Codex connection and requests that this connection close. Live updates remain paused until the user explicitly restores the phone connection.

Restoring updates does not automatically resume a handed-back conversation or send a saved message. Connecting that conversation and submitting a queued message require separate, explicit actions. After using the ordinary connection control, choose **Send saved messages** in the saved-message panel to authorize those requests. The action remains available while saved requests still need confirmation.

The service may retain an idle writer during an unload grace period. A successful `thread/unsubscribe` response confirms only the subscription operation. An empty loaded-thread list or a closed phone connection does not independently prove that the computer can acquire the writer. Pocket Bridge must not display immediate handover as confirmed on those signals alone.

## What the local test established

With the tested Windows Codex app-server version 0.159.0, the service unloaded the idle conversation approximately 60 seconds after the final phone unsubscribe and connection closure. An independent writer attempt made several seconds after handback was still rejected. A later attempt succeeded after the service had completed its own thread teardown. No desktop or app-server process was stopped.

The teardown was recorded before an earlier successful attempt associated with closing a browser tab. That result must not be attributed solely to closing the tab. A final controlled test then kept the phone page open with updates paused: the pre-check was rejected, in-page handback was operated, and the independent instance resumed the same conversation approximately one minute later. Both services remained running.

The observed 60 seconds is specific to this tested environment. Other versions, configuration, active work, or remaining subscribers can change the delay. It is not a cross-version promise or a countdown that proves the writer is available.

## Release acceptance check

To validate handback, first confirm that an independent Codex instance cannot resume the conversation while the phone owns it. Perform the explicit handback, leave the page open with updates paused, and allow the service to finish its idle unload. Then verify that the independent instance can resume that exact conversation. Do not substitute static tests, subscription responses, or loaded-thread counts for this final check.

For users, the intended message is: the phone has requested handback and paused its connection; the computer may need to wait for the service to release its writer. If sending remains blocked, keep the phone connection paused and use an independent continuation while investigating the actual owner.
