# Revert UI Process Management Features - Implementation Plan

## Overview

This plan outlines how to cleanly revert the UI-based process management features (ProcessContext, status polling, kill buttons) while preserving the core abort signal handling functionality for terminal commands.

## Context

Based on product feedback from Rostik (Slack discussion), the UI process management features add unnecessary complexity for a cloud-based system with E2B's 6-minute sandbox timeout. The simpler approach is:
- **Keep**: Abort signal handling that kills processes when user clicks stop during active generation
- **Remove**: All UI polling, status indicators, kill buttons, and related infrastructure

## Current State Analysis

### Added Files (to be removed):
1. **app/contexts/ProcessContext.tsx** (383 lines)
   - Global process state management
   - localStorage persistence per chat
   - Batch polling every 5 seconds
   - Kill process coordination

2. **app/contexts/useTerminalProcess.ts** (78 lines)
   - Reusable hook for process management
   - Wraps ProcessContext functionality

3. **app/api/check-processes/route.ts** (155 lines)
   - Batch endpoint for checking multiple process statuses
   - Uses batch-process-checker utility

4. **app/api/kill-process/route.ts** (106 lines)
   - Endpoint for killing individual processes
   - Connects to E2B sandbox

5. **lib/ai/tools/utils/batch-process-checker.ts** (165 lines)
   - Efficient batch process checking
   - Single ps call for multiple processes

6. **lib/ai/tools/utils/retry-with-backoff.ts**
   - Exponential backoff retry logic
   - Used for sandbox connection reliability

7. **lib/ai/tools/utils/sandbox-health.ts**
   - Sandbox health checking utilities

### Modified Files (need partial revert):

1. **lib/ai/tools/run-terminal-cmd.ts**
   - **Keep**: Abort signal handler with PID discovery
   - **Keep**: Process termination logic for both foreground/background
   - **Remove**: Any UI-related process tracking (if any)

2. **lib/ai/tools/utils/pid-discovery.ts**
   - **Keep**: Entire file - needed for abort signal handling

3. **lib/ai/tools/utils/process-termination.ts**
   - **Keep**: Entire file - needed for abort signal handling

4. **app/components/TerminalToolHandler.tsx**
   - **Remove**: ProcessContext imports and usage
   - **Remove**: Process polling useEffect
   - **Remove**: Kill button handlers
   - **Remove**: Status badge rendering
   - **Keep**: Basic tool display logic

5. **app/components/ComputerSidebar.tsx**
   - **Remove**: ProcessContext imports and usage
   - **Remove**: Process polling useEffect
   - **Remove**: Kill button handlers
   - **Remove**: Status badge rendering
   - **Keep**: Basic sidebar display logic

6. **app/components/TerminalCodeBlock.tsx**
   - **Remove**: isProcessRunning prop and status display
   - **Keep**: Basic terminal output display

7. **app/components/chat.tsx**
   - **Remove**: ProcessContext usage
   - **Remove**: Process clearing on chat change

8. **app/layout.tsx**
   - **Remove**: ProcessProvider wrapper

### Files to Keep:
- **lib/ai/tools/utils/background-process-tracker.ts** - Used by AI to track background processes and their output files

## Desired End State

After this revert:
1. Terminal commands have abort signal handling that kills processes when user clicks stop **during active generation**
2. No UI polling or status indicators after command execution completes
3. No kill buttons in UI
4. No ProcessContext or global process state
5. No API routes for process management
6. Users can ask AI to check/kill processes via terminal commands
7. Simpler codebase aligned with other AI agents

### Verification:
- User clicks stop on running `ping google.com` → process terminates immediately
- User clicks stop on background `nmap -p- target` → process terminates immediately
- After command completes, no status badges or kill buttons appear
- No continuous polling or API calls to check process status
- Build passes, tests pass, no TypeScript errors

## What We're NOT Doing

- We're NOT removing abort signal handling in run-terminal-cmd.ts
- We're NOT removing PID discovery utilities (needed for abort)
- We're NOT removing process termination utilities (needed for abort)
- We're NOT removing background-process-tracker (AI uses this)
- We're NOT making it impossible to kill processes (AI can do it via terminal commands)

## Implementation Approach

Use git to understand the baseline state before UI features were added, then selectively revert changes while preserving abort signal handling improvements.

## Phase 1: Remove ProcessContext Infrastructure

### Overview
Remove the ProcessContext system and all files that depend solely on it.

### Changes Required:

#### 1. Delete ProcessContext Files
**Files to delete**:
- `app/contexts/ProcessContext.tsx`
- `app/contexts/useTerminalProcess.ts`

```bash
git rm app/contexts/ProcessContext.tsx
git rm app/contexts/useTerminalProcess.ts
```

#### 2. Delete API Routes
**Files to delete**:
- `app/api/check-processes/route.ts`
- `app/api/kill-process/route.ts`

```bash
git rm app/api/check-processes/route.ts
git rm app/api/kill-process/route.ts
```

#### 3. Delete UI-Specific Utilities
**Files to delete**:
- `lib/ai/tools/utils/batch-process-checker.ts`
- `lib/ai/tools/utils/retry-with-backoff.ts`
- `lib/ai/tools/utils/sandbox-health.ts`

```bash
git rm lib/ai/tools/utils/batch-process-checker.ts
git rm lib/ai/tools/utils/retry-with-backoff.ts
git rm lib/ai/tools/utils/sandbox-health.ts
```

### Success Criteria:

#### Automated Verification:
- [x] All file deletions successful: `git status` shows deleted files
- [x] TypeScript compilation may have errors at this point (will fix in Phase 2)

#### Manual Verification:
- [x] Confirm deleted files are the correct ones
- [x] No accidental deletion of abort signal handling files

---

## Phase 2: Remove ProcessProvider from Layout

### Overview
Remove the ProcessProvider wrapper from app layout.

### Changes Required:

#### 1. Update app/layout.tsx
**File**: `app/layout.tsx`

Find and remove the ProcessProvider import and wrapper:

```typescript
// REMOVE this import:
import { ProcessProvider } from "./contexts/ProcessContext";

// REMOVE the ProcessProvider wrapper in the JSX tree
// Change from:
<ProcessProvider>
  {children}
</ProcessProvider>

// To:
{children}
```

### Success Criteria:

#### Automated Verification:
- [x] File compiles without ProcessProvider
- [x] No unused import warnings

#### Manual Verification:
- [x] App still renders without ProcessProvider

---

## Phase 3: Revert TerminalToolHandler Changes

### Overview
Remove all ProcessContext usage from TerminalToolHandler, keeping only basic tool display.

### Changes Required:

#### 1. Clean up app/components/tools/TerminalToolHandler.tsx

**Remove**:
- ProcessContext imports
- useTerminalProcess hook usage
- Process polling useEffect
- Kill button handlers
- Status badge logic
- isProcessRunning state

**Strategy**: Compare with baseline version before UI features were added:
```bash
git show origin/main:app/components/tools/TerminalToolHandler.tsx > /tmp/baseline.tsx
```

Then restore the basic structure while keeping any non-UI improvements.

**Expected structure**:
```typescript
// Keep basic imports
import React from "react";
import { UIMessage } from "@ai-sdk/react";
import { CommandResult } from "@e2b/code-interpreter";
import ToolBlock from "@/components/ui/tool-block";
import { Terminal } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus, SidebarTerminal } from "@/types/chat";

// Remove ProcessContext imports
// Remove useTerminalProcess

export const TerminalToolHandler = ({ message, part, status }) => {
  const { openSidebar } = useGlobalState();

  // Remove all process polling state
  // Remove all kill handlers

  const handleOpenInSidebar = () => {
    // Keep sidebar opening logic
    // Remove process status tracking
  };

  // Render ToolBlock without statusBadge or onKill props
  return (
    <ToolBlock
      icon={<Terminal />}
      action="Executed"
      target={command}
      isClickable={true}
      onClick={handleOpenInSidebar}
      // Remove: statusBadge prop
      // Remove: onKill prop
      // Remove: isKilling prop
    />
  );
};
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes for this file
- [x] No unused imports
- [x] No references to ProcessContext

#### Manual Verification:
- [x] Terminal tool blocks still display and are clickable
- [x] Sidebar still opens on click
- [x] No status badges or kill buttons visible

---

## Phase 4: Revert ComputerSidebar Changes

### Overview
Remove ProcessContext usage and process status UI from the sidebar.

### Changes Required:

#### 1. Clean up app/components/ComputerSidebar.tsx

**Remove**:
- ProcessContext imports
- useTerminalProcess hook usage
- Process polling useEffect
- Kill button UI
- Status badge UI
- isProcessRunning state

**Keep**:
- Basic sidebar display
- File/terminal/python content rendering
- Minimize functionality

**Strategy**: Compare with baseline:
```bash
git show origin/main:app/components/ComputerSidebar.tsx > /tmp/baseline-sidebar.tsx
```

**Expected changes**:
```typescript
// Remove ProcessContext imports
// Remove useTerminalProcess

export const ComputerSidebar: React.FC = () => {
  const { sidebarOpen, sidebarContent, closeSidebar } = useGlobalState();

  // Remove all process polling logic
  // Remove all kill button handlers

  // In the action text section (line ~277-316):
  // Remove the status badge and kill button JSX:
  {/* REMOVE THIS ENTIRE BLOCK:
  {isTerminal && sidebarContent.isBackground && pid && isProcessRunning && (
    <>
      <span className="...">Running</span>
      <span onClick={handleKillProcess}>×</span>
    </>
  )}
  */}

  // Keep basic sidebar rendering
};
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes for this file
- [x] No unused imports
- [x] No references to ProcessContext

#### Manual Verification:
- [x] Sidebar still displays terminal output correctly
- [x] No status badges or kill buttons visible
- [x] Sidebar can still be minimized

---

## Phase 5: Revert TerminalCodeBlock Changes

### Overview
Remove process status display features from TerminalCodeBlock.

### Changes Required:

#### 1. Update app/components/TerminalCodeBlock.tsx

**Remove**:
- `isProcessRunning` prop from interface
- Process status text rendering
- Any conditional logic based on process state

**Strategy**: Compare with baseline:
```bash
git show origin/main:app/components/TerminalCodeBlock.tsx > /tmp/baseline-terminal.tsx
```

**Expected changes**:
```typescript
// In the interface, remove:
// isProcessRunning?: boolean | null;

// Remove any status text like "Running in background" or "Completed"
// Keep basic terminal output display
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes
- [x] No unused props

#### Manual Verification:
- [x] Terminal output still renders correctly
- [x] No process status text displayed

---

## Phase 6: Revert Chat Component Changes

### Overview
Remove ProcessContext usage from chat component.

### Changes Required:

#### 1. Update app/components/chat.tsx

**Remove**:
- ProcessContext imports
- setCurrentChatId calls
- clearAllProcesses calls

**Strategy**: Check what was changed:
```bash
git diff origin/main...HEAD -- app/components/chat.tsx
```

Then revert ProcessContext-related changes while keeping other improvements.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes
- [x] No references to ProcessContext

#### Manual Verification:
- [x] Chat functionality still works
- [x] Switching chats works normally

---

## Phase 7: Verify Abort Signal Handling Still Works

### Overview
Ensure that the core abort signal handling in run-terminal-cmd.ts is intact and functional.

### Changes Required:

#### 1. Review lib/ai/tools/run-terminal-cmd.ts

**Verify these features are present**:
- abort signal listener registration
- onAbort handler that discovers PID and kills process
- Integration with pid-discovery.ts
- Integration with process-termination.ts
- Proper cleanup and exit code (130) on abort

**Check the abort handler structure** (around line 78-115):
```typescript
const onAbort = async () => {
  // For foreground commands, discover PID if not known
  if (!processId && !is_background) {
    processId = await findProcessPid(sandbox, command);
  }

  // Terminate the process
  if ((execution && execution.kill) || processId) {
    await terminateProcessReliably(sandbox, execution, processId);
  }

  // Resolve with abort status
  resolve({
    result: {
      output: result.output,
      exitCode: 130,
      error: "Command execution aborted by user",
    },
  });
};

abortSignal?.addEventListener("abort", onAbort, { once: true });
```

**No changes needed** to this file - just verification.

### Success Criteria:

#### Automated Verification:
- [x] File compiles successfully
- [x] No broken imports from deleted files

#### Manual Verification:
- [x] Abort handler is present and correct
- [x] PID discovery import works
- [x] Process termination import works

---

## Phase 8: Final Testing & Cleanup

### Overview
Run full test suite and verify the system works correctly.

### Testing Steps:

#### 1. TypeScript Compilation
```bash
pnpm tsc --noEmit
```

#### 2. Build Production Bundle
```bash
pnpm build
```

#### 3. Run Test Suite (if available)
```bash
pnpm test
```

#### 4. Manual Testing Scenarios

**Test 1: Foreground Command Abort**
1. Start chat
2. Run: `ping -c 100 google.com`
3. Wait for output to start streaming
4. Click stop button
5. Verify: Process terminates immediately (no more pings)
6. Verify: No status badges or kill buttons appear

**Test 2: Background Command Abort**
1. Start chat
2. Run: `ping -c 100 google.com` (as background via AI)
3. Wait for command to start
4. Click stop button during generation
5. Verify: Process terminates immediately
6. Verify: No status badges or kill buttons appear

**Test 3: Command Completion**
1. Run: `echo "hello"`
2. Wait for completion
3. Verify: No polling or status indicators
4. Verify: No kill buttons
5. Verify: Basic terminal output displays correctly

**Test 4: Sidebar Display**
1. Run any terminal command
2. Click on the tool block
3. Verify: Sidebar opens with output
4. Verify: No status badges or kill buttons in sidebar
5. Verify: Can close sidebar normally

**Test 5: Long Running Command**
1. Run: `sleep 30`
2. Click stop after a few seconds
3. Verify: Command aborts immediately
4. Verify: No errors in console
5. Verify: No UI polling after stop

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `pnpm tsc --noEmit`
- [x] Production build succeeds: `pnpm build`
- [x] No console errors in browser
- [x] No TypeScript errors
- [x] No unused imports or dead code warnings

#### Manual Verification:
- [ ] Can stop foreground commands with stop button (during generation)
- [ ] Can stop background commands with stop button (during generation)
- [ ] No status badges appear after command completion
- [ ] No kill buttons in UI
- [ ] No polling or API calls to check-processes endpoint
- [ ] Sidebar displays terminal output correctly
- [ ] No errors in browser console
- [ ] Chat functionality works normally

---

## Testing Strategy

### Unit Tests (if applicable):
- Test abort signal handler in isolation
- Test PID discovery utility
- Test process termination utility

### Integration Tests:
- Test full abort flow: command start → stop button → process terminated
- Test both foreground and background command abort
- Test timeout handling

### Manual Testing Steps:
Covered in Phase 8 above.

## Performance Considerations

**Improvements from revert**:
- Eliminates continuous 5-second polling
- Removes API calls to check-processes endpoint
- Reduces localStorage writes
- Simplifies React component tree (no ProcessContext)
- Reduces bundle size by removing unused code

## Migration Notes

This is a pure revert with no data migration needed. The ProcessContext localStorage entries will simply be orphaned and unused, causing no issues. They can be manually cleaned up later if desired.

**For users**:
- No action required
- Existing chats continue to work
- Background processes that were running before the revert will time out naturally (E2B 6-minute limit)

## References

- Slack discussion with Rostik (Nov 5, 2025)
- Original PR: #72 (abort signal handling)
- Baseline commit: `41c1b14` (abort signal implementation)
- Current branch: `fix/abort-signal-handling`

## Appendix: Commit Strategy

After completing all phases:

1. **Single commit approach** (recommended):
```bash
git add -A
git commit -m "revert: remove UI process management features

Remove ProcessContext, API routes, and UI polling/kill buttons while
preserving core abort signal handling for terminal commands.

Based on product feedback, the simpler approach is to let AI handle
process management via terminal commands rather than adding UI complexity.

Removed:
- ProcessContext and useTerminalProcess hook
- /api/check-processes and /api/kill-process endpoints
- Batch process checker and retry utilities
- UI status badges and kill buttons
- Process polling and localStorage persistence

Kept:
- Abort signal handling in run-terminal-cmd.ts
- PID discovery for foreground commands
- Process termination utilities
- Background process tracking for AI

This aligns with how other AI agents work and reduces complexity for
cloud-based sandboxes with 6-minute timeouts."
```

2. **Push to branch**:
```bash
git push --force-with-lease
```

**Note**: Force push is appropriate here since this is a feature branch being actively worked on.
