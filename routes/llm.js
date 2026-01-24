const express = require('express');
const router = express.Router();
const { AzureOpenAI } = require('openai');
const { userOps, llmLogOps } = require('../models/database');
const { verifyToken } = require('../middleware/auth');

// Store active sessions (threadId -> { client, assistantId, userId })
const activeSessions = new Map();

/**
 * Helper: Check if a run is active
 */
function isRunActive(status) {
    return status === 'queued' || status === 'in_progress' || status === 'requires_action';
}

function extractActiveRunIdFromErrorMessage(msg) {
    if (typeof msg !== 'string') {
        return null;
    }

    const m = msg.match(/while a run (run_[A-Za-z0-9]+) is active\.?/);
    return m?.[1] || null;
}

async function retrieveRunUsageWithRetry(client, threadId, runId) {
    if (!client?.beta?.threads?.runs?.retrieve || !runId) {
        return null;
    }

    let lastRun = null;
    for (let i = 0; i < 6; i++) {
        try {
            lastRun = await client.beta.threads.runs.retrieve(threadId, runId);
        } catch (e) {
            lastRun = null;
        }

        const usage = lastRun?.usage;
        if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
            return {
                inputTokens: usage.prompt_tokens || 0,
                outputTokens: usage.completion_tokens || 0
            };
        }

        // If the run is still active, usage commonly isn't available yet.
        // Avoid noisy warnings for requires_action / in_progress states.
        if (lastRun?.status && isRunActive(lastRun.status)) {
            return null;
        }

        if (i < 5) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    // Only warn for terminal runs missing usage.
    if (lastRun?.status && isRunActive(lastRun.status)) {
        return null;
    }

    console.warn('[LLM] Run usage missing after retries', {
        threadId,
        runId,
        status: lastRun?.status,
        hasUsage: Boolean(lastRun?.usage)
    });

    return null;
}

/**
 * Helper: Cancel active runs for a thread
 */
async function cancelActiveRuns(client, threadId, excludeRunId) {
    if (!client?.beta?.threads?.runs?.list) {
        return;
    }

    const runs = await client.beta.threads.runs.list(threadId, { limit: 10 });
    const data = runs?.data || [];

    for (const r of data) {
        if (!r?.id || r.id === excludeRunId) {
            continue;
        }
        if (!isRunActive(r.status)) {
            continue;
        }

        if (!client?.beta?.threads?.runs?.cancel) {
            continue;
        }

        await client.beta.threads.runs.cancel(threadId, r.id);

        if (client?.beta?.threads?.runs?.retrieve) {
            for (let i = 0; i < 10; i++) {
                const rr = await client.beta.threads.runs.retrieve(threadId, r.id);
                if (!isRunActive(rr?.status)) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }
    }
}

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
                name: 'report_issue',
                description: 'Report a single WCAG non-compliance issue by appending it to the accessibility report memory file. Use this in Report Mode after analyzing a file (do not fix the issue).',
                parameters: {
                    type: 'object',
                    properties: {
                        file: {
                            type: 'string',
                            description: 'Relative file path where the issue was found (relative to project root)'
                        },
                        line: {
                            type: 'number',
                            description: '1-based line number where the issue was found (use best effort if approximate)'
                        },
                        wcagGuideline: {
                            type: 'string',
                            description: 'WCAG criterion/guideline (e.g., "1.1.1 Non-text Content")'
                        },
                        level: {
                            type: 'string',
                            enum: ['A', 'AA', 'AAA'],
                            description: 'Conformance level (A, AA, or AAA)'
                        },
                        severity: {
                            type: 'string',
                            enum: ['low', 'medium', 'high', 'critical'],
                            description: 'Severity of the issue'
                        },
                        issue: {
                            type: 'string',
                            description: 'Short description of what is non-compliant'
                        },
                        recommendation: {
                            type: 'string',
                            description: 'Recommended action to address the issue'
                        },
                        principle: {
                            type: 'string',
                            description: 'Optional: WCAG principle (Perceivable, Operable, Understandable, Robust)'
                        },
                        snippet: {
                            type: 'string',
                            description: 'Optional: relevant code snippet or excerpt'
                        }
                    },
                    required: ['file', 'line', 'wcagGuideline', 'level', 'severity', 'issue', 'recommendation']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'generate_report',
                description: 'Generate the accessibility non-compliance report webview from the accumulated report memory file. Call this once after all files have been scanned in Report Mode.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: 'Optional report title (e.g., "Accessibility Compliance Report")'
                        },
                        filesScanned: {
                            type: 'number',
                            description: 'Optional: number of files scanned during the audit'
                        }
                    },
                    required: []
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'attempt_completion',
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
    let threadId;
    let message;
    try {
        ({ threadId, message } = req.body);

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

        await cancelActiveRuns(client, threadId);

        // Add message to thread
        try {
            await client.beta.threads.messages.create(threadId, {
                role: 'user',
                content: message
            });
        } catch (e) {
            const runIdFromErr = extractActiveRunIdFromErrorMessage(e?.message);
            if (runIdFromErr && client?.beta?.threads?.runs?.cancel) {
                await client.beta.threads.runs.cancel(threadId, runIdFromErr);
                await cancelActiveRuns(client, threadId);
                await client.beta.threads.messages.create(threadId, {
                    role: 'user',
                    content: message
                });
            } else {
                throw e;
            }
        }

        // Stream the run
        const stream = await client.beta.threads.runs.stream(threadId, {
            assistant_id: assistantId
        });

        const streamResult = await handleStream(stream, res);

        let inputTokens = streamResult.inputTokens || 0;
        let outputTokens = streamResult.outputTokens || 0;

        const usage = await retrieveRunUsageWithRetry(client, threadId, streamResult.runId);
        if (usage) {
            inputTokens = usage.inputTokens;
            outputTokens = usage.outputTokens;
        }

        // Log the request with token usage
        try {
            llmLogOps.logRequest(
                threadId,
                'chat',
                streamResult.toolCallCount || 0,
                inputTokens,
                outputTokens,
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
            if (threadId) {
                llmLogOps.logRequest(threadId, 'chat', 0, 0, 0, 'error', error.message);
                llmLogOps.updateSessionStatus(threadId, 'error', error.message);
            }
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
    let threadId;
    let runId;
    let toolOutputs;
    try {
        ({ threadId, runId, toolOutputs } = req.body);

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

        await cancelActiveRuns(client, threadId, runId);

        // Submit tool outputs and stream
        const stream = await client.beta.threads.runs.submitToolOutputsStream(
            threadId,
            runId,
            { tool_outputs: toolOutputs }
        );

        const streamResult = await handleStream(stream, res);

        let inputTokens = streamResult.inputTokens || 0;
        let outputTokens = streamResult.outputTokens || 0;

        if (!streamResult.runId) {
            console.warn('[LLM] Missing runId from stream (tool-outputs); cannot retrieve usage', { threadId, runId });
        } else {
            const usage = await retrieveRunUsageWithRetry(client, threadId, streamResult.runId);
            if (usage) {
                inputTokens = usage.inputTokens;
                outputTokens = usage.outputTokens;
            }
        }

        // Log the tool output request
        try {
            llmLogOps.logRequest(
                threadId,
                'tool_output',
                toolOutputs.length,
                inputTokens,
                outputTokens,
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
            if (threadId) {
                llmLogOps.logRequest(threadId, 'tool_output', toolOutputs?.length || 0, 0, 0, 'error', error.message);
            }
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
            if (!runId) {
                if (event?.data?.id && typeof event.event === 'string' && event.event.startsWith('thread.run.')) {
                    runId = event.data.id;
                } else if (event?.data?.run_id) {
                    runId = event.data.run_id;
                }
            } else if (event?.data?.run_id && !runId) {
                runId = event.data.run_id;
            }

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

        if (!runId) {
            console.warn('[LLM] Stream completed without runId; token usage cannot be retrieved');
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
            runId,
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
            runId,
            inputTokens,
            outputTokens,
            toolCallCount: toolCalls.filter(t => t && t.id).length,
            error: error.message
        };
    }
}

module.exports = router;
