import { Veto } from 'veto-sdk/browser';

const veto = Veto.fromRules({
mode: 'strict',
rules: [
{
id: 'block-sensitive-urls',
name: 'Block navigation to banking sites',
enabled: true,
severity: 'critical',
action: 'block',
tools: ['navigate', 'goto', 'click_link'],
conditions: [
{
field: 'arguments.url',
operator: 'matches',
value: '.*\\.(bank|chase|wellsfargo)\\.com.*'
}
]
},
{
id: 'block-form-submit',
name: 'Block form submissions with sensitive data',
enabled: true,
severity: 'high',
action: 'block',
tools: ['fill_form', 'submit', 'type'],
conditions: [
{
field: 'arguments.value',
operator: 'matches',
value: '\\b\\d{3}-\\d{2}-\\d{4}\\b'
}
]
}
]
});

// In your browser agent's action loop:
async function executeAction(action: BrowserAction) {
const result = await veto.guard(action.name, action.args);
if (result.decision === 'deny') {
console.warn(`Blocked: ${result.reason}`);
return;
}
return originalExecute(action);
}
