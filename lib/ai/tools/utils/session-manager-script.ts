/**
 * Python script that runs inside the sandbox to manage tmux sessions.
 * This script is written to the sandbox on first use and handles all session operations.
 */
export const SESSION_MANAGER_SCRIPT = `#!/usr/bin/env python3
"""
Terminal session manager using tmux for persistent interactive shell sessions.
Provides session management with command completion detection and special key support.

All responses use a simplified 4-field format:
- content: string - command output or error message
- status: "completed" | "running" | "error"
- exit_code: int | None
- working_dir: string
"""
import subprocess
import sys
import json
import time
import re

# Custom PS1 for command completion detection
PS1_MARKER = "[SESS_$?]$ "
PS1_PATTERN = r"\\[SESS_(\\d+)\\]\\$"

def run_cmd(cmd, timeout=30):
    """Run a command and return result."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired:
        return "", "Command timed out", -1
    except Exception as e:
        return "", str(e), -1

def ensure_tmux():
    """Ensure tmux is installed, trying multiple package managers if needed."""
    stdout, _, rc = run_cmd("command -v tmux")
    if rc == 0 and stdout.strip():
        return True

    # Try different package managers based on what's available
    package_managers = [
        ("apt-get", "apt-get update -qq 2>/dev/null && apt-get install -y -qq tmux 2>/dev/null"),
        ("apk", "apk add --no-cache tmux 2>/dev/null"),
        ("dnf", "dnf install -y -q tmux 2>/dev/null"),
        ("yum", "yum install -y -q tmux 2>/dev/null"),
        ("pacman", "pacman -Sy --noconfirm tmux 2>/dev/null"),
    ]

    for pm_check, install_cmd in package_managers:
        pm_stdout, _, pm_rc = run_cmd(f"command -v {pm_check}")
        if pm_rc == 0 and pm_stdout.strip():
            run_cmd(install_cmd, timeout=60)
            stdout, _, rc = run_cmd("command -v tmux")
            if rc == 0 and stdout.strip():
                return True

    return False

def session_exists(session_id):
    """Check if a tmux session exists."""
    _, _, rc = run_cmd(f"tmux has-session -t '{session_id}' 2>/dev/null")
    return rc == 0

def create_session(session_id, work_dir="/home/user"):
    """Create a new tmux session."""
    if session_exists(session_id):
        return True

    # Explicitly use bash for consistent PS1 behavior across platforms (macOS defaults to zsh)
    cmd = f"tmux new-session -d -s '{session_id}' -c '{work_dir}' 'exec bash --norc --noprofile'"
    _, _, rc = run_cmd(cmd)
    if rc != 0:
        # Fallback: try without explicit bash (in case bash isn't available)
        cmd = f"tmux new-session -d -s '{session_id}' -c '{work_dir}'"
        _, _, rc = run_cmd(cmd)
        if rc != 0:
            return False

    time.sleep(0.3)
    # Use PROMPT_COMMAND to ensure PS1 is set before every prompt display
    # This is more robust than setting PS1 once - it survives commands that try to change it
    # Also disable PS2 (continuation prompt) for simpler output parsing
    send_keys(session_id, 'export PROMPT_COMMAND=\\'export PS1=\"[SESS_$?]$ \"\\'; export PS2=\"\"', enter=True)
    time.sleep(0.3)
    send_keys(session_id, "clear", enter=True)
    time.sleep(0.2)

    return True

def send_keys(session_id, keys, enter=True):
    """Send keys to a tmux session."""
    escaped_keys = keys.replace("'", "'\\\\''")

    if enter:
        cmd = f"tmux send-keys -t '{session_id}' '{escaped_keys}' Enter"
    else:
        cmd = f"tmux send-keys -t '{session_id}' '{escaped_keys}'"

    _, _, rc = run_cmd(cmd)
    return rc == 0

def send_special_key(session_id, key):
    """Send special key (like C-c, C-d, Up, Down, etc.) to a tmux session."""
    cmd = f"tmux send-keys -t '{session_id}' {key}"
    _, _, rc = run_cmd(cmd)
    return rc == 0

def capture_pane(session_id, history_lines=1000):
    """Capture the content of a tmux pane."""
    cmd = f"tmux capture-pane -t '{session_id}' -p -S -{history_lines}"
    stdout, _, rc = run_cmd(cmd)
    if rc == 0:
        return stdout
    return ""

def get_working_dir(session_id):
    """Get the current working directory of a tmux session."""
    cmd = f"tmux display-message -t '{session_id}' -p '#{{pane_current_path}}'"
    stdout, _, rc = run_cmd(cmd)
    if rc == 0 and stdout.strip():
        return stdout.strip()
    return "/home/user"

def clean_output(content, command=None):
    """Clean up output by removing internal prompt markers and command echo."""
    if not content:
        return ""

    lines = content.split("\\n")
    cleaned_lines = []
    prompt_pattern = re.compile(r"^\\[SESS_\\d+\\]\\$ ")

    for line in lines:
        if not cleaned_lines and not line.strip():
            continue

        cleaned_line = prompt_pattern.sub("", line)

        if command and not cleaned_lines and cleaned_line.strip() == command.strip():
            continue

        if re.match(r"^\\[SESS_\\d+\\]\\$ $", line.rstrip() + " "):
            continue

        cleaned_lines.append(cleaned_line)

    while cleaned_lines and (not cleaned_lines[-1].strip() or re.match(r"^\\[SESS_\\d+\\]\\$ ?$", cleaned_lines[-1].strip())):
        cleaned_lines.pop()

    return "\\n".join(cleaned_lines)

def get_pane_command(session_id):
    """Get the current command running in the pane."""
    cmd = f"tmux display-message -t '{session_id}' -p '#{{pane_current_command}}'"
    stdout, _, rc = run_cmd(cmd)
    if rc == 0:
        return stdout.strip()
    return ""

def is_command_running(session_id):
    """Check if a command is currently running in the session."""
    pane_cmd = get_pane_command(session_id)
    shell_names = {"bash", "zsh", "sh", "fish", "dash", "ash", "ksh", "tcsh", "csh"}
    if pane_cmd:
        # Normalize the command name:
        # - Strip leading dash for login shells (e.g., "-zsh" -> "zsh")
        # - Extract basename from full paths (e.g., "/bin/zsh" -> "zsh")
        normalized_cmd = pane_cmd.lstrip("-").split("/")[-1]
        if normalized_cmd not in shell_names:
            return True

    content = capture_pane(session_id)
    if not content:
        return False

    lines = content.rstrip().split("\\n")
    if not lines:
        return False

    last_line = lines[-1].rstrip()
    return not (last_line.endswith("]$ ") or re.search(PS1_PATTERN, last_line))

def get_exit_code(session_id):
    """Extract the exit code from the last prompt."""
    content = capture_pane(session_id)
    if not content:
        return None

    matches = list(re.finditer(PS1_PATTERN, content))
    if matches:
        return int(matches[-1].group(1))
    return None

def is_special_key(key):
    """Check if the key is a special tmux key sequence."""
    if not key:
        return False

    if key.startswith("C-") and len(key) >= 3:
        return True
    if key.startswith("M-") and len(key) >= 3:
        return True
    if key.startswith("S-") and len(key) >= 3:
        return True

    if key.startswith("F") and len(key) <= 3:
        try:
            num = int(key[1:])
            if 1 <= num <= 12:
                return True
        except ValueError:
            pass

    special_keys = {
        "Up", "Down", "Left", "Right",
        "Home", "End", "PageUp", "PageDown", "PPage", "NPage",
        "Enter", "Escape", "Tab", "BTab",
        "Space", "BSpace", "DC", "IC"
    }

    return key in special_keys

def wait_for_command_start(session_id, command, max_wait=2.0):
    """Wait for the command to appear in the pane output."""
    start_time = time.time()
    while time.time() - start_time < max_wait:
        content = capture_pane(session_id)
        if command in content:
            return True
        time.sleep(0.1)
    return True

def extract_command_output(pre_content, post_content, command=None):
    """Extract only the new output (delta) between pre and post execution content."""
    if not post_content:
        return ""

    pre_lines = pre_content.split("\\n") if pre_content else []
    post_lines = post_content.split("\\n")

    start_idx = 0
    pre_line_count = len(pre_lines)
    while pre_line_count > 0 and not pre_lines[pre_line_count - 1].strip():
        pre_line_count -= 1

    start_idx = max(0, pre_line_count - 1)

    prompt_pattern = re.compile(r"^\\[SESS_\\d+\\]\\$ ")
    command_found = False

    for i in range(start_idx, len(post_lines)):
        line = post_lines[i]
        clean_line = prompt_pattern.sub("", line).strip()

        if command and clean_line == command.strip():
            start_idx = i + 1
            command_found = True
            break
        if command and line.strip().endswith(command.strip()):
            start_idx = i + 1
            command_found = True
            break

    if not command_found and command:
        for i in range(start_idx, len(post_lines)):
            if command in post_lines[i]:
                start_idx = i + 1
                break

    new_lines = post_lines[start_idx:]

    cleaned_lines = []
    for line in new_lines:
        cleaned_line = prompt_pattern.sub("", line)

        if re.match(r"^\\[SESS_\\d+\\]\\$ ?$", line.rstrip() + " "):
            continue

        cleaned_lines.append(cleaned_line)

    while cleaned_lines and (not cleaned_lines[-1].strip() or re.match(r"^\\[SESS_\\d+\\]\\$ ?$", cleaned_lines[-1].strip())):
        cleaned_lines.pop()

    return "\\n".join(cleaned_lines)

def stream_output(new_content, is_final=False):
    """Output a streaming update to stdout."""
    if new_content:
        stream_data = {"type": "stream", "output": new_content, "final": is_final}
        print(f"STREAM:{json.dumps(stream_data)}", flush=True)

def make_result(content, status, exit_code, working_dir):
    """Create a standardized result object."""
    # Content passed through - TypeScript handles token-based truncation
    return {
        "content": content or "",
        "status": status,
        "exit_code": exit_code,
        "working_dir": working_dir
    }

def action_view(session_id):
    """View the content of a shell session."""
    if not session_exists(session_id):
        return make_result(
            f"Session '{session_id}' does not exist. Use 'exec' action to create it.",
            "error",
            None,
            "/home/user"
        )

    raw_content = capture_pane(session_id)
    content = clean_output(raw_content)
    running = is_command_running(session_id)
    exit_code = None if running else get_exit_code(session_id)
    working_dir = get_working_dir(session_id)

    status = "running" if running else "completed"
    return make_result(content, status, exit_code, working_dir)

def action_exec(session_id, command, timeout=30, work_dir="/home/user"):
    """Execute a command in a shell session."""
    working_dir = work_dir

    # Create session if it doesn't exist
    if not session_exists(session_id):
        if not create_session(session_id, work_dir):
            return make_result(
                f"Failed to create session '{session_id}'",
                "error",
                None,
                working_dir
            )

    working_dir = get_working_dir(session_id)

    # Check if something is already running
    if is_command_running(session_id):
        raw_content = capture_pane(session_id)
        content = clean_output(raw_content)
        return make_result(
            "A command is already running. Use is_input=true to send input to it, or interrupt it first (e.g., with C-c).",
            "error",
            None,
            working_dir
        )

    # Capture pane content BEFORE executing to calculate delta later
    pre_exec_content = capture_pane(session_id)

    # Execute the command
    send_keys(session_id, command, enter=True)

    # Wait for command to start
    time.sleep(0.3)
    wait_for_command_start(session_id, command)
    time.sleep(0.2)

    # Wait for completion or timeout with streaming updates
    start_time = time.time()
    consecutive_prompt_checks = 0
    last_streamed_length = 0
    stream_interval = 0.5
    last_stream_time = time.time()

    while time.time() - start_time < timeout:
        time.sleep(0.3)

        current_content = capture_pane(session_id)
        current_output = extract_command_output(pre_exec_content, current_content, command)

        if current_output and len(current_output) > last_streamed_length:
            if time.time() - last_stream_time >= stream_interval:
                new_content = current_output[last_streamed_length:]
                if new_content.strip():
                    stream_output(new_content)
                    last_streamed_length = len(current_output)
                    last_stream_time = time.time()

        if not is_command_running(session_id):
            consecutive_prompt_checks += 1
            if consecutive_prompt_checks >= 2:
                raw_content = capture_pane(session_id)
                content = extract_command_output(pre_exec_content, raw_content, command)
                exit_code = get_exit_code(session_id)
                working_dir = get_working_dir(session_id)

                if content and len(content) > last_streamed_length:
                    remaining = content[last_streamed_length:]
                    if remaining.strip():
                        stream_output(remaining, is_final=True)

                return make_result(content, "completed", exit_code, working_dir)
        else:
            consecutive_prompt_checks = 0

    # Timeout - command still running
    raw_content = capture_pane(session_id)
    content = extract_command_output(pre_exec_content, raw_content, command)
    working_dir = get_working_dir(session_id)

    if content and len(content) > last_streamed_length:
        remaining = content[last_streamed_length:]
        if remaining.strip():
            stream_output(remaining, is_final=True)

    if content.strip():
        timeout_msg = f"\\n[Command still running after {timeout}s - showing output so far.]"
    else:
        timeout_msg = f"[Command still running after {timeout}s. No output yet.]"
    return make_result(content + timeout_msg, "running", None, working_dir)

def action_wait(session_id, timeout=30):
    """Wait for the running process in a shell session to complete."""
    if not session_exists(session_id):
        return make_result(
            f"Session '{session_id}' does not exist.",
            "error",
            None,
            "/home/user"
        )

    working_dir = get_working_dir(session_id)
    pre_wait_content = capture_pane(session_id)

    # Check if anything is running
    if not is_command_running(session_id):
        raw_content = capture_pane(session_id)
        content = clean_output(raw_content)
        exit_code = get_exit_code(session_id)
        return make_result(content, "completed", exit_code, working_dir)

    # Wait for completion with streaming updates
    start_time = time.time()
    last_streamed_length = 0
    stream_interval = 0.5
    last_stream_time = time.time()

    while time.time() - start_time < timeout:
        time.sleep(0.3)

        current_content = capture_pane(session_id)
        current_output = extract_command_output(pre_wait_content, current_content, None)

        if current_output and len(current_output) > last_streamed_length:
            if time.time() - last_stream_time >= stream_interval:
                new_content = current_output[last_streamed_length:]
                if new_content.strip():
                    stream_output(new_content)
                    last_streamed_length = len(current_output)
                    last_stream_time = time.time()

        if not is_command_running(session_id):
            raw_content = capture_pane(session_id)
            content = extract_command_output(pre_wait_content, raw_content, None)
            exit_code = get_exit_code(session_id)
            working_dir = get_working_dir(session_id)

            if content and len(content) > last_streamed_length:
                remaining = content[last_streamed_length:]
                if remaining.strip():
                    stream_output(remaining, is_final=True)

            return make_result(content, "completed", exit_code, working_dir)

    # Timeout
    raw_content = capture_pane(session_id)
    content = extract_command_output(pre_wait_content, raw_content, None)
    working_dir = get_working_dir(session_id)

    if content and len(content) > last_streamed_length:
        remaining = content[last_streamed_length:]
        if remaining.strip():
            stream_output(remaining, is_final=True)

    if content.strip():
        timeout_msg = f"\\n[Command still running after {timeout}s - showing output so far.]"
    else:
        timeout_msg = f"[Command still running after {timeout}s. No output yet.]"
    return make_result(content + timeout_msg, "running", None, working_dir)

def decode_escape_sequences(text):
    """Decode common escape sequences from literal strings."""
    try:
        return text.encode('raw_unicode_escape').decode('unicode_escape')
    except (UnicodeDecodeError, UnicodeEncodeError):
        result = text
        replacements = [
            ('\\\\n', '\\n'),
            ('\\\\t', '\\t'),
            ('\\\\r', '\\r'),
            ('\\\\\\\\', '\\\\'),
        ]
        for old, new in replacements:
            result = result.replace(old, new)
        return result

def action_send(session_id, input_text):
    """Send input to the active process in a shell session."""
    if not session_exists(session_id):
        return make_result(
            f"Session '{session_id}' does not exist.",
            "error",
            None,
            "/home/user"
        )

    working_dir = get_working_dir(session_id)

    # Check if a command is running - if not, can't send input
    if not is_command_running(session_id):
        raw_content = capture_pane(session_id)
        content = clean_output(raw_content)
        return make_result(
            "No command is currently running. Cannot send input.",
            "error",
            None,
            working_dir
        )

    # Handle special keys vs regular input
    stripped = input_text.strip()
    if is_special_key(stripped):
        send_special_key(session_id, stripped)
    else:
        decoded = decode_escape_sequences(input_text)

        if decoded.endswith("\\n"):
            send_keys(session_id, decoded[:-1], enter=True)
        else:
            send_keys(session_id, decoded, enter=False)

    time.sleep(0.3)
    raw_content = capture_pane(session_id)
    content = clean_output(raw_content)
    running = is_command_running(session_id)
    working_dir = get_working_dir(session_id)

    if running:
        return make_result(content, "running", None, working_dir)
    else:
        exit_code = get_exit_code(session_id)
        return make_result(content, "completed", exit_code, working_dir)

def get_pane_pid(session_id):
    """Get the PID of the process running in the tmux pane."""
    cmd = f"tmux display-message -t '{session_id}' -p '#{{pane_pid}}'"
    stdout, _, rc = run_cmd(cmd)
    if rc == 0 and stdout.strip():
        try:
            return int(stdout.strip())
        except ValueError:
            pass
    return None

def get_foreground_pid(pane_pid):
    """Get the foreground process PID for a given shell PID."""
    if not pane_pid:
        return None
    cmd = f"ps -o pid= --ppid {pane_pid} 2>/dev/null | head -1"
    stdout, _, rc = run_cmd(cmd)
    if rc == 0 and stdout.strip():
        try:
            return int(stdout.strip())
        except ValueError:
            pass
    return None

def action_kill(session_id):
    """Terminate the running process in a shell session."""
    if not session_exists(session_id):
        return make_result(
            f"Session '{session_id}' does not exist.",
            "error",
            None,
            "/home/user"
        )

    # Try various methods to kill the process
    methods = [
        ("C-c", 0.5),
        ("C-d", 0.5),
        ("C-c", 0.2),
        ("C-d", 0.3),
        ("C-\\\\", 0.5),
    ]

    for key, wait_time in methods:
        send_special_key(session_id, key)
        time.sleep(wait_time)

        if not is_command_running(session_id):
            raw_content = capture_pane(session_id)
            content = clean_output(raw_content)
            exit_code = get_exit_code(session_id)
            working_dir = get_working_dir(session_id)
            return make_result(content, "completed", exit_code, working_dir)

    # Try to kill the foreground process directly
    pane_pid = get_pane_pid(session_id)
    fg_pid = get_foreground_pid(pane_pid)
    if fg_pid and fg_pid != pane_pid:
        run_cmd(f"kill -9 {fg_pid} 2>/dev/null")
        time.sleep(0.5)

    raw_content = capture_pane(session_id)
    content = clean_output(raw_content)
    running = is_command_running(session_id)
    working_dir = get_working_dir(session_id)

    if running:
        return make_result(
            content + "\\n[Process may still be running]",
            "running",
            None,
            working_dir
        )
    else:
        exit_code = get_exit_code(session_id)
        return make_result(content, "completed", exit_code, working_dir)

def main():
    if len(sys.argv) < 2:
        print(json.dumps(make_result("No action specified", "error", None, "/home/user")))
        sys.exit(1)

    if not ensure_tmux():
        print(json.dumps(make_result(
            "tmux is not available and could not be installed. Please install tmux manually.",
            "error",
            None,
            "/home/user"
        )))
        sys.exit(1)

    action = sys.argv[1]

    try:
        if action == "view":
            session_id = sys.argv[2] if len(sys.argv) > 2 else "default"
            result = action_view(session_id)

        elif action == "exec":
            session_id = sys.argv[2] if len(sys.argv) > 2 else "default"
            command = sys.argv[3] if len(sys.argv) > 3 else ""
            timeout = int(sys.argv[4]) if len(sys.argv) > 4 else 30
            work_dir = sys.argv[5] if len(sys.argv) > 5 else "/home/user"
            result = action_exec(session_id, command, timeout, work_dir)

        elif action == "wait":
            session_id = sys.argv[2] if len(sys.argv) > 2 else "default"
            timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 30
            result = action_wait(session_id, timeout)

        elif action == "send":
            session_id = sys.argv[2] if len(sys.argv) > 2 else "default"
            input_text = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else ""
            result = action_send(session_id, input_text)

        elif action == "kill":
            session_id = sys.argv[2] if len(sys.argv) > 2 else "default"
            result = action_kill(session_id)

        else:
            result = make_result(f"Unknown action: {action}", "error", None, "/home/user")

        print(json.dumps(result))

    except Exception as e:
        print(json.dumps(make_result(str(e), "error", None, "/home/user")))
        sys.exit(1)

if __name__ == "__main__":
    main()
`;

/**
 * Path where the session manager script is stored in the sandbox
 */
export const SESSION_MANAGER_PATH = "/tmp/.hackerai_session_manager.py";
