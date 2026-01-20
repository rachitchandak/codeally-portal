const express = require('express');
const router = express.Router();
const { AzureOpenAI } = require('openai');
const { userOps, llmLogOps } = require('../models/database');
const { verifyToken } = require('../middleware/auth');

// Store active sessions (threadId -> { client, assistantId, userId })
const activeSessions = new Map();

/**
 * Helper: Get or create Azure OpenAI client for user
 */
function getAzureClient(user) {
    if (!user.apiKey || !user.azureResourceName || !user.azureDeployment) {
        throw new Error('User Azure config not complete');
    }

    return new AzureOpenAI({
        apiKey: user.apiKey,
        endpoint: `https://${user.azureResourceName}.openai.azure.com/`,
        apiVersion: user.azureApiVersion || '2024-05-01-preview',
        deployment: user.azureDeployment,
    });
}

/**
 * Helper: Get tool definitions (mirrored from backend)
 * These must match the backend's tool definitions for the assistant
 */
function getToolDefinitions() {
    return [
        {
            type: 'function',
            function: {
                name: 'read_file',
                description: 'Read the contents of a file at the specified path. Use this to examine existing code, configuration files, or any text-based file.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Relative path to the file from project root'
                        }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'write_file',
                description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does. Use for creating new files or modifying existing ones.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Relative path to the file from project root'
                        },
                        content: {
                            type: 'string',
                            description: 'The complete content to write to the file'
                        }
                    },
                    required: ['path', 'content']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'list_directory',
                description: 'List the contents of a directory. Returns files and subdirectories with basic info.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Relative path to the directory from project root. Use "." for project root.'
                        }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'grep_search',
                description: 'Search for a pattern in files. Useful for finding where something is defined or used in the codebase.',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: {
                            type: 'string',
                            description: 'The search pattern (supports regex)'
                        },
                        path: {
                            type: 'string',
                            description: 'Directory or file to search in (relative to project root). Use "." for entire project.'
                        },
                        include: {
                            type: 'string',
                            description: 'Optional glob pattern to filter files (e.g., "*.ts" for TypeScript files)'
                        }
                    },
                    required: ['pattern']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'done',
                description: 'Call this when you have completed the task. Provide a summary of what was accomplished.',
                parameters: {
                    type: 'object',
                    properties: {
                        result: {
                            type: 'string',
                            description: 'Summary of what was accomplished'
                        },
                        command: {
                            type: 'string',
                            description: 'Optional command for the user to run (e.g., to start a server or run tests)'
                        }
                    },
                    required: ['result']
                }
            }
        }
    ];
}

/**
 * POST /api/llm/assistant
 * Initialize an assistant and create a thread for the user session
 */
router.post('/assistant', verifyToken, async (req, res) => {
    try {
        const { instructions } = req.body;
        const user = req.user;

        // Get Azure client for this user
        const client = getAzureClient(user);

        // Create assistant with tools
        const assistant = await client.beta.assistants.create({
            name: 'Agentic Coder',
            instructions: instructions || 'You are an expert AI coding assistant.',
            tools: getToolDefinitions(),
            model: user.azureDeployment,
        });

        // Create thread
        const thread = await client.beta.threads.create();

        // Store session
        activeSessions.set(thread.id, {
            client,
            assistantId: assistant.id,
            userId: user.id,
            deploymentName: user.azureDeployment
        });

        // Log session creation
        try {
            llmLogOps.createSession(thread.id, assistant.id, user.id, user.email);
            console.log(`[LLM] Session logged: thread=${thread.id}, user=${user.email}`);
        } catch (logError) {
            console.error('[LLM] Failed to log session:', logError);
        }

        console.log(`[LLM] Session created: thread=${thread.id}, assistant=${assistant.id}, user=${user.email}`);

        res.json({
            threadId: thread.id,
            assistantId: assistant.id
        });
    } catch (error) {
        console.error('[LLM] Assistant init error:', error);

        // Map common errors to user-friendly messages
        if (error.message?.includes('API key')) {
            return res.status(401).json({ error: 'INVALID_API_KEY', message: 'Invalid Azure API key' });
        }
        if (error.message?.includes('resource')) {
            return res.status(400).json({ error: 'INVALID_RESOURCE', message: 'Azure resource not found' });
        }

        res.status(500).json({ error: 'LLM_ERROR', message: error.message });
    }
});

/**
 * POST /api/llm/chat
 * Send a message and stream the response via SSE
 */
router.post('/chat', verifyToken, async (req, res) => {
    try {
        const { threadId, message } = req.body;

        if (!threadId || !message) {
            return res.status(400).json({ error: 'Missing threadId or message' });
        }

        const session = activeSessions.get(threadId);
        if (!session) {
            return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Thread session not found. Call /assistant first.' });
        }

        // Verify user owns this session
        if (session.userId !== req.user.id) {
            return res.status(403).json({ error: 'UNAUTHORIZED', message: 'Not authorized to access this session' });
        }

        const { client, assistantId } = session;

        // Set up SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Add message to thread
        await client.beta.threads.messages.create(threadId, {
            role: 'user',
            content: message
        });

        // Stream the run
        const stream = await client.beta.threads.runs.stream(threadId, {
            assistant_id: assistantId
        });

        const streamResult = await handleStream(stream, res);

        // Log the request with token usage
        try {
            llmLogOps.logRequest(
                threadId,
                'chat',
                streamResult.toolCallCount || 0,
                streamResult.inputTokens || 0,
                streamResult.outputTokens || 0,
                streamResult.error ? 'error' : 'success',
                streamResult.error || null
            );
        } catch (logError) {
            console.error('[LLM] Failed to log chat request:', logError);
        }

    } catch (error) {
        console.error('[LLM] Chat error:', error);

        // Log the error
        try {
            llmLogOps.logRequest(threadId, 'chat', 0, 0, 0, 'error', error.message);
            llmLogOps.updateSessionStatus(threadId, 'error', error.message);
        } catch (logError) {
            console.error('[LLM] Failed to log error:', logError);
        }

        // If headers already sent, send error via SSE
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: 'LLM_ERROR', message: error.message });
        }
    }
});

/**
 * POST /api/llm/tool-outputs
 * Submit tool outputs and continue streaming
 */
router.post('/tool-outputs', verifyToken, async (req, res) => {
    try {
        const { threadId, runId, toolOutputs } = req.body;

        if (!threadId || !runId || !toolOutputs) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const session = activeSessions.get(threadId);
        if (!session) {
            return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Thread session not found' });
        }

        if (session.userId !== req.user.id) {
            return res.status(403).json({ error: 'UNAUTHORIZED' });
        }

        const { client } = session;

        // Set up SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Submit tool outputs and stream
        const stream = await client.beta.threads.runs.submitToolOutputsStream(
            threadId,
            runId,
            { tool_outputs: toolOutputs }
        );

        const streamResult = await handleStream(stream, res);

        // Log the tool output request
        try {
            llmLogOps.logRequest(
                threadId,
                'tool_output',
                toolOutputs.length,
                streamResult.inputTokens || 0,
                streamResult.outputTokens || 0,
                streamResult.error ? 'error' : 'success',
                streamResult.error || null
            );
        } catch (logError) {
            console.error('[LLM] Failed to log tool output request:', logError);
        }

    } catch (error) {
        console.error('[LLM] Tool outputs error:', error);

        // Log the error
        try {
            llmLogOps.logRequest(threadId, 'tool_output', toolOutputs?.length || 0, 0, 0, 'error', error.message);
        } catch (logError) {
            console.error('[LLM] Failed to log error:', logError);
        }

        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: 'LLM_ERROR', message: error.message });
        }
    }
});

/**
 * DELETE /api/llm/session/:threadId
 * Clean up a session
 */
router.delete('/session/:threadId', verifyToken, (req, res) => {
    const { threadId } = req.params;
    const session = activeSessions.get(threadId);

    if (session && session.userId === req.user.id) {
        activeSessions.delete(threadId);

        // Update session status to completed
        try {
            llmLogOps.updateSessionStatus(threadId, 'completed');
        } catch (logError) {
            console.error('[LLM] Failed to update session status:', logError);
        }

        console.log(`[LLM] Session deleted: ${threadId}`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

/**
 * Helper: Handle streaming response and forward via SSE
 */
async function handleStream(stream, res) {
    let runId = '';
    const toolCalls = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let streamError = null;

    try {
        for await (const event of stream) {
            if (event.event === 'thread.message.delta') {
                const delta = event.data.delta.content?.[0];
                if (delta?.type === 'text' && delta.text?.value) {
                    res.write(`data: ${JSON.stringify({ type: 'text', content: delta.text.value })}\n\n`);
                }
            } else if (event.event === 'thread.run.step.delta') {
                const delta = event.data.delta;
                if (delta.step_details?.type === 'tool_calls') {
                    for (const tc of delta.step_details.tool_calls) {
                        if (tc.type === 'function') {
                            if (!toolCalls[tc.index]) {
                                toolCalls[tc.index] = {
                                    id: tc.id || '',
                                    type: 'function',
                                    function: { name: '', arguments: '' }
                                };
                            }
                            if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                            if (tc.id) toolCalls[tc.index].id = tc.id;
                        }
                    }
                }
            } else if (event.event === 'thread.run.requires_action') {
                runId = event.data.id;
                // Extract token usage if available
                if (event.data.usage) {
                    inputTokens = event.data.usage.prompt_tokens || 0;
                    outputTokens = event.data.usage.completion_tokens || 0;
                }
            } else if (event.event === 'thread.run.completed') {
                runId = event.data.id;
                // Extract token usage from completed run
                if (event.data.usage) {
                    inputTokens = event.data.usage.prompt_tokens || 0;
                    outputTokens = event.data.usage.completion_tokens || 0;
                }
            } else if (event.event === 'thread.run.failed') {
                runId = event.data.id;
                streamError = event.data.last_error?.message || 'Run failed';
            }
        }

        // Filter out empty slots and send tool calls if any
        const finalToolCalls = toolCalls.filter(t => t && t.id);

        if (finalToolCalls.length > 0) {
            res.write(`data: ${JSON.stringify({ type: 'tool_calls', runId, toolCalls: finalToolCalls })}\n\n`);
        }

        // Send done event
        res.write(`data: ${JSON.stringify({ type: 'done', runId })}\n\n`);
        res.end();

        // Return token usage and tool call count for logging
        return {
            inputTokens,
            outputTokens,
            toolCallCount: finalToolCalls.length,
            error: streamError
        };

    } catch (error) {
        console.error('[LLM] Stream error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();

        return {
            inputTokens,
            outputTokens,
            toolCallCount: toolCalls.filter(t => t && t.id).length,
            error: error.message
        };
    }
}

module.exports = router;
