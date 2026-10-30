# Third-party interface references

The prototype uses original HTML and CSS written for this class project. Its
three interaction shells are visual adaptations of open-source coding-agent
interfaces. No upstream JavaScript or product assets are bundled.

## OpenHands

- Project: <https://github.com/All-Hands-AI/OpenHands>
- License: MIT
- Revision inspected: `060621fde6a7c62cce7aaabd7f992970bdc976ea`
- Primary reference:
  `src/components/features/conversation/conversation-main/conversation-main.tsx`
- Adapted ideas: split conversation/workspace layout, task status and composer
  placement.

## Cline

- Project: <https://github.com/cline/cline>
- License: Apache License 2.0
- Revision inspected: `1619168bdeb570aa233d0f0a9af1d332d83a2816`
- Primary references:
  `apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/ActionButtons.tsx`
  and `apps/vscode/webview-ui/src/main.css`
- Adapted ideas: VS Code activity rail, side-panel conversation, editor area and
  action placement.

## OpenAI Codex CLI

- Project: <https://github.com/openai/codex>
- License: Apache License 2.0
- Revision inspected: `f3a90545aed3188ee1e5c119ec89a742de399cdc`
- Primary reference: `codex-rs/tui/src/bottom_pane/approval_overlay.rs`
- Adapted ideas: terminal transcript, command-approval overlay and composer.

Product names identify the interfaces used as research references. This class
prototype is not affiliated with or endorsed by those projects.
