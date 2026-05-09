import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// List of dangerous commands to block in YOLO mode
const BLOCKED_COMMANDS = [
  /^rm\s+-rf\s+\//,  // rm -rf /
  /^mkfs/,              // format filesystem
  /^dd\s+/,             // dangerous dd
  /^:(){/,              // fork bomb
  /^>\/dev\/sda/,       // direct device write
  /^chmod\s+777/,       // overly permissive
  /^wget\s+.+\|\s*bash/, // pipe wget to bash
  /^curl\s+.+\|\s*bash/, // pipe curl to bash
];

export const tools = [
  {
    type: "function",
    function: {
      name: "run_shell_command",
      description: "Run a shell command on the local machine and return its output. Commands are validated for safety.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for files in the workspace using combined path pattern, content pattern, and optional directory. More efficient than multiple shell commands.",
      parameters: {
        type: "object",
        properties: {
          name_pattern: {
            type: "string",
            description: "File name pattern to match (e.g., '*.java', '*Util*')",
          },
          content_pattern: {
            type: "string",
            description: "Optional text to search for within files (e.g., 'class KriProExcel')",
          },
          directory: {
            type: "string",
            description: "Optional root directory to search in (defaults to workspace)",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results to return (default: 50)",
          },
        },
        required: ["name_pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file.",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "The path of the file to read.",
          },
        },
        required: ["filepath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file. Overwrites if it exists.",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "The path of the file to write.",
          },
          content: {
            type: "string",
            description: "The content to write.",
          },
        },
        required: ["filepath", "content"],
      },
    },
  },
];

function validateCommand(command: string): string | null {
  const trimmed = command.trim().toLowerCase();
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(trimmed)) {
      return `Command blocked for safety: ${command}`;
    }
  }
  return null;
}

export async function runShellCommand(command: string): Promise<string> {
  console.log(`[Tool: run_shell_command] ${command}`);
  
  // Validate command
  const validationError = validateCommand(command);
  if (validationError) {
    return validationError;
  }
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30000, // 30 second timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB output limit
    });
    let output = stdout;
    if (stderr) {
      output += `\nStderr:\n${stderr}`;
    }
    return output.trim() || "Command executed successfully with no output.";
  } catch (error: any) {
    return `Error executing command: ${error.message}\nStderr:\n${error.stderr || ""}`;
  }
}

export async function searchFiles(params: {
  name_pattern: string;
  content_pattern?: string;
  directory?: string;
  max_results?: number;
}): Promise<string> {
  const { name_pattern, content_pattern, directory, max_results } = params;
  const searchDir = directory || process.env.WORKSPACE || ".";
  const limit = max_results || 50;
  
  console.log(`[Tool: search_files] pattern=${name_pattern}, content=${content_pattern || "any"}, dir=${searchDir}`);
  
  try {
    // Use find for efficient file discovery
    let command: string;
    
    if (content_pattern) {
      // Search by name AND content
      command = `find ${searchDir} -type f -name "${name_pattern}" -exec grep -l "${content_pattern}" {} \\; 2>/dev/null | head -${limit}`;
    } else {
      // Search by name only
      command = `find ${searchDir} -type f -name "${name_pattern}" 2>/dev/null | head -${limit}`;
    }
    
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
    
    const files = stdout.split("\n").filter((f) => f.trim()).slice(0, limit);
    
    if (files.length === 0) {
      return `No files found matching pattern "${name_pattern}"${content_pattern ? ` containing "${content_pattern}"` : ""} in ${searchDir}`;
    }
    
    let result = `Found ${files.length} file(s):\n`;
    result += files.map((f) => `  - ${f}`).join("\n");
    
    if (stderr) {
      result += `\n\nWarnings/Errors:\n${stderr}`;
    }
    
    return result;
  } catch (error: any) {
    return `Error searching files: ${error.message}`;
  }
}

export async function readFile(filepath: string): Promise<string> {
  console.log(`[Tool: read_file] ${filepath}`);
  try {
    // Prevent directory traversal
    const resolved = path.resolve(filepath);
    const workspace = process.env.WORKSPACE ? path.resolve(process.env.WORKSPACE) : null;
    
    if (workspace && !resolved.startsWith(workspace)) {
      return `Error: File path must be within workspace (${workspace})`;
    }
    
    const content = await fs.readFile(resolved, "utf-8");
    return content;
  } catch (error: any) {
    return `Error reading file: ${error.message}`;
  }
}

export async function writeFile(filepath: string, content: string): Promise<string> {
  console.log(`[Tool: write_file] ${filepath}`);
  try {
    // Prevent directory traversal
    const resolved = path.resolve(filepath);
    const workspace = process.env.WORKSPACE ? path.resolve(process.env.WORKSPACE) : null;
    
    if (workspace && !resolved.startsWith(workspace)) {
      return `Error: File path must be within workspace (${workspace})`;
    }
    
    await fs.writeFile(resolved, content, "utf-8");
    return `File written successfully to ${resolved}`;
  } catch (error: any) {
    return `Error writing file: ${error.message}`;
  }
}

export const toolRunner = {
  run_shell_command: (args: any) => runShellCommand(args.command),
  search_files: (args: any) => searchFiles(args),
  read_file: (args: any) => readFile(args.filepath),
  write_file: (args: any) => writeFile(args.filepath, args.content),
};
