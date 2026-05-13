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
  {
    type: "function",
    function: {
      name: "inspect_ui_component",
      description: "Inspect the rendered CSS properties of a UI component by its Vue file path or CSS selector. Returns the computed styles that would affect event handling and visibility, such as overflow, position, z-index, display, etc. Use this to quickly diagnose UI interaction bugs without manually tracing through multiple files.",
      parameters: {
        type: "object",
        properties: {
          component_file: {
            type: "string",
            description: "Path to the Vue component file to inspect (e.g., 'ui/src/layout/components/Navbar.vue')",
          },
          css_selector: {
            type: "string",
            description: "CSS selector for the specific element within the component to inspect (e.g., '.navbar', '.avatar-container'). If not provided, inspects all class selectors in the component.",
          },
        },
        required: ["component_file"],
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

export async function inspectUIComponent(params: {
  component_file: string;
  css_selector?: string;
}): Promise<string> {
  const { component_file, css_selector } = params;
  console.log(`[Tool: inspect_ui_component] file=${component_file}, selector=${css_selector || "all class rules"}`);
  
  try {
    // Read the component file
    const fullPath = path.resolve(component_file);
    const content = await fs.readFile(fullPath, "utf-8");
    
    // Extract <style> section (both scoped and unscoped)
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/g;
    let styles: string[] = [];
    let match;
    while ((match = styleRegex.exec(content)) !== null) {
      styles.push(match[1]);
    }
    
    if (styles.length === 0) {
      return `No <style> section found in ${component_file}`;
    }
    
    let result = `## UI Component: ${component_file}\n\n`;
    
    if (css_selector) {
      // Extract CSS rules for the specific selector
      const allCss = styles.join("\n");
      
      // Parse the CSS to find rules matching the selector
      const cssLines = allCss.split("\n");
      let inBlock = false;
      let currentSelector = "";
      let foundRules: string[] = [];
      
      for (const line of cssLines) {
        const trimmed = line.trim();
        
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
          continue; // skip comments
        }
        
        if (trimmed.includes("{")) {
          currentSelector = trimmed.split("{")[0].trim();
          inBlock = true;
          continue;
        }
        
        if (trimmed.includes("}")) {
          inBlock = false;
          currentSelector = "";
          continue;
        }
        
        if (inBlock && currentSelector.includes(css_selector)) {
          foundRules.push(`  ${trimmed}`);
        }
      }
      
      if (foundRules.length > 0) {
        result += `### CSS properties for selector "${css_selector}":\n\n`;
        result += foundRules.join("\n");
        result += "\n\n";
        
        // Extract key interaction-affecting properties
        const interactionProps = foundRules.filter(rule => {
          const lower = rule.toLowerCase();
          return lower.includes("overflow") || 
                 lower.includes("position") || 
                 lower.includes("z-index") || 
                 lower.includes("display") || 
                 lower.includes("visibility") || 
                 lower.includes("pointer-events") ||
                 lower.includes("opacity");
        });
        
        if (interactionProps.length > 0) {
          result += `### ⚠️ Potential interaction-affecting properties:\n\n`;
          result += interactionProps.join("\n");
          result += "\n\n";
        }
      } else {
        result += `No CSS rules found for selector "${css_selector}" in this component.\n\n`;
      }
    }
    
    result += `### All CSS sections (${styles.length} found):\n\n`;
    styles.forEach((styleContent, index) => {
      const lines = styleContent.split("\n").filter(l => l.trim());
      result += `<style section ${index + 1}>\n`;
      lines.forEach(line => result += `  ${line}\n`);
      result += `</style section ${index + 1}>\n\n`;
    });
    
    return result;
  } catch (error: any) {
    return `Error inspecting UI component: ${error.message}`;
  }
}

export const toolRunner = {
  run_shell_command: (args: any) => runShellCommand(args.command),
  search_files: (args: any) => searchFiles(args),
  read_file: (args: any) => readFile(args.filepath),
  write_file: (args: any) => writeFile(args.filepath, args.content),
  inspect_ui_component: (args: any) => inspectUIComponent(args),
};
