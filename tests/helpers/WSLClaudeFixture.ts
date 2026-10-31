/** A network/auth-free CLI peer for the real Agent SDK's stdio control protocol. */
export const WSL_CLAUDE_FIXTURE = `#!/usr/bin/python3
import json, os, re, sys
if '--version' in sys.argv:
    print('2.1.99 (Claude Code)')
    sys.exit(0)
initial = {}
def send(value):
    print(json.dumps(value), flush=True)
def finish(mcp=None):
    report = dict(cwd=os.getcwd(), argv=sys.argv[1:], home=os.environ.get('HOME'),
        config=os.environ.get('CLAUDE_CONFIG_DIR'), custom=os.environ.get('CLAUDIAN_TEST_VALUE'),
        auth=os.environ.get('ANTHROPIC_API_KEY'), prompt=initial.get('systemPrompt'), mcp=mcp)
    send(dict(type='assistant', uuid='assistant-1', session_id='session-wsl', parent_tool_use_id=None,
        message=dict(id='message-1', role='assistant', model='fixture-model',
            content=[dict(type='text', text=json.dumps(report))], usage=dict(input_tokens=1, output_tokens=1))))
    send(dict(type='result', subtype='success', session_id='session-wsl', is_error=False,
        duration_ms=1, duration_api_ms=0, num_turns=1, result='fixture', total_cost_usd=0,
        usage=dict(input_tokens=1, output_tokens=1), modelUsage={}, permission_denials=[]))
for line in sys.stdin:
    message = json.loads(line)
    if message.get('type') == 'control_request':
        request = message['request']
        response = {}
        if request['subtype'] == 'initialize':
            initial = request
            response = dict(commands=[], models=[], agents=[], available_output_styles=[], output_style='default')
        send(dict(type='control_response', response=dict(subtype='success', request_id=message['request_id'], response=response)))
        if request['subtype'] == 'initialize':
            send(dict(type='system', subtype='init', session_id='session-wsl', cwd=os.getcwd(),
                tools=[], mcp_servers=[], model='fixture-model', permissionMode='default',
                slash_commands=[], skills=[], output_style='default', apiKeySource='none', uuid='init-1'))
    elif message.get('type') == 'user':
        if initial.get('sdkMcpServers'):
            send(dict(type='control_request', request_id='fixture-mcp', request=dict(subtype='mcp_message',
                server_name=initial['sdkMcpServers'][0], message=dict(jsonrpc='2.0', id=1,
                method='tools/call', params=dict(name='read_fixture', arguments={})))))
        else:
            finish()
    elif message.get('type') == 'control_response' and message['response'].get('request_id') == 'fixture-mcp':
        finish(message['response'])
`;
