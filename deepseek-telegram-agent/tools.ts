import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import OpenAI from "openai";
import { RunnableToolFunction } from "openai/lib/RunnableFunction";

const execAsync = promisify(exec);

export const tools = [
  {
    type: "function",
    function: {
      name: "run_shell_command",
      description: "Run a shell command on the local machine and return its output.",
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
] as const;

export async function runShellCommand(command: string): Promise<string> {
  console.log(`[Tool: run_shell_command] ${command}`);
  try {
    const { stdout, stderr } = await execAsync(command);
    let output = stdout;
    if (stderr) {
      output += `\nStderr:\n${stderr}`;
    }
    return output.trim() || "Command executed successfully with no output.";
  } catch (error: any) {
    return `Error executing command: ${error.message}\nStderr:\n${error.stderr || ""}`;
  }
}

export async function readFile(filepath: string): Promise<string> {
  console.log(`[Tool: read_file] ${filepath}`);
  try {
    const content = await fs.readFile(filepath, "utf-8");
    return content;
  } catch (error: any) {
    return `Error reading file: ${error.message}`;
  }
}

export async function writeFile(filepath: string, content: string): Promise<string> {
  console.log(`[Tool: write_file] ${filepath}`);
  try {
    await fs.writeFile(filepath, content, "utf-8");
    return `File written successfully to ${filepath}`;
  } catch (error: any) {
    return `Error writing file: ${error.message}`;
  }
}

export const toolRunner = {
  run_shell_command: (args: any) => runShellCommand(args.command),
  read_file: (args: any) => readFile(args.filepath),
  write_file: (args: any) => writeFile(args.filepath, args.content),
};
