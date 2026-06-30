/**
 * Custom Extension Example
 * 
 * This example shows how to build extensions for pi-coding-agent with:
 * - Custom tools
 * - Commands
 * - Event handling
 * - UI customization
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Define a custom tool
const jokeTool = {
  name: "tell_joke",
  label: "Tell Joke",
  description: "Tells a random joke",
  parameters: Type.Object({
    category: Type.String({ 
      description: "Joke category (tech, general, programming)",
      enum: ["tech", "general", "programming"] as const
    }),
    setupOnly: Type.Boolean({ 
      description: "Return only the setup without punchline",
      default: false 
    })
  }),
  
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    // Sample joke database
    const jokes = {
      tech: [
        "Why do Java developers wear glasses? Because they can't C#!",
        "What's the best thing about Switzerland? I don't know, but the flag is a big plus.",
        "How many programmers does it take to change a light bulb? None, that's a hardware problem."
      ],
      general: [
        "Why don't scientists trust atoms? Because they make up everything!",
        "What do you call a fake noodle? An impasta!",
        "Did you hear about the restaurant on the moon? It was great food, but no atmosphere!"
      ],
      programming: [
        "Why did the programmer quit his job? He didn't get arrays.",
        "What's a programmer's favorite hangout place? Foo Bar!",
        "How many programmers does it take to change a light bulb? None, they just write a new program."
      ]
    };

    const categoryJokes = jokes[params.category as keyof typeof jokes] || jokes.general;
    const joke = categoryJokes[Math.floor(Math.random() * categoryJokes.length)];
    
    if (params.setupOnly) {
      return {
        content: [{ type: "text", text: `Setup: ${joke.split('?')[0]}?` }],
        details: { usedCategory: params.category }
      };
    } else {
      return {
        content: [{ type: "text", text: joke }],
        details: { usedCategory: params.category }
      };
    }
  },
};

// Define a command that uses the tool
const setupJokeCommand = {
  description: "Tell a joke (usage: /joke [category])",
  handler: async (args, ctx) => {
    const category = args.trim() || 'general';
    
    // Ensure we have valid category
    if (!['tech', 'general', 'programming'].includes(category)) {
      ctx.ui.notify(`Invalid category: ${category}. Use tech, general, or programming.`, "warning");
      return;
    }

    try {
      // Call the tool with given parameters
      const result = await ctx.sessionManager.callTool("tell_joke", { 
        category,
        setupOnly: false 
      });
      
      ctx.ui.notify(`Joke: ${result.content[0].text}`, "info");
    } catch (error) {
      ctx.ui.notify(`Error telling joke: ${(error as Error).message}`, "error");
    }
  },
};

// Main extension function
export default function customExtension(pi: ExtensionAPI) {
  // Register the custom tool
  pi.registerTool(jokeTool);
  
  // Register the command
  pi.registerCommand("joke", setupJokeCommand);
  
  // Listen to session start events for demonstration purposes
  pi.on("session_start", async (_event, ctx) => {
    console.log("Session started - extension is active!");
    
    // You can access current tools
    const allTools = pi.getAllTools();
    if (allTools.some(t => t.name === "tell_joke")) {
      console.log("Joke tool registered successfully");
    }
    
    // Set up any persistent state or default configurations here
  });
  
  // Listen to specific tool calls for logging or extra functionality  
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "tell_joke") {
      console.log(`User called joke tool with category: ${event.input.category}`);
      ctx.ui.notify("Preparing a joke...", "info");
    }
  });
}

// Extension metadata for documentation
/**
 * Extension Metadata:
 * 
 * Name: Custom Joke Extension
 * Description: Provides a custom tool and command to tell jokes during conversation
 * Usage:
 *   - Use the /joke command (e.g., `/joke tech` or `/joke programming`)
 *   - The extension also registers a "tell_joke" tool that can be used in prompts
 * 
 * Features:
 *   - Custom tool with parameters and structured output
 *   - Command that integrates with UI notifications  
 *   - Event handling for session start and tool calls
 */