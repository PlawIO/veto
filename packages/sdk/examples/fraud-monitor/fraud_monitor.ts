/**
 * Fraud Monitor Example (TypeScript)
 *
 * Transaction monitoring system using Veto's LOG mode
 * to observe all transactions without blocking.
 */

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import 'dotenv/config';

import { createAgent, tool } from 'langchain';
import { z } from 'zod';
import { Veto } from 'veto-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Simulated Transaction Data
// =============================================================================

interface Transaction {
    id: string;
    accountId: string;
    type: 'credit' | 'debit' | 'transfer';
    amount: number;
    currency: string;
    merchant?: string;
    recipient?: string;
    location: string;
    timestamp: string;
    riskScore: number;
    flagged: boolean;
}

interface Account {
    id: string;
    holder: string;
    type: 'personal' | 'business';
    balance: number;
    riskLevel: 'low' | 'medium' | 'high';
}

const ACCOUNTS: Record<string, Account> = {
    'ACC001': { id: 'ACC001', holder: 'John Doe', type: 'personal', balance: 15420.50, riskLevel: 'low' },
    'ACC002': { id: 'ACC002', holder: 'Tech Corp Inc', type: 'business', balance: 245000.00, riskLevel: 'low' },
    'ACC003': { id: 'ACC003', holder: 'Jane Smith', type: 'personal', balance: 8750.25, riskLevel: 'medium' },
    'ACC004': { id: 'ACC004', holder: 'Suspicious LLC', type: 'business', balance: 500000.00, riskLevel: 'high' },
};

const TRANSACTIONS: Transaction[] = [
    { id: 'TXN001', accountId: 'ACC001', type: 'debit', amount: 45.99, currency: 'USD', merchant: 'Amazon', location: 'US', timestamp: '2026-01-06T10:30:00Z', riskScore: 5, flagged: false },
    { id: 'TXN002', accountId: 'ACC001', type: 'debit', amount: 1200.00, currency: 'USD', merchant: 'Best Buy', location: 'US', timestamp: '2026-01-06T11:15:00Z', riskScore: 25, flagged: false },
    { id: 'TXN003', accountId: 'ACC002', type: 'transfer', amount: 50000.00, currency: 'USD', recipient: 'Vendor Corp', location: 'US', timestamp: '2026-01-06T09:00:00Z', riskScore: 15, flagged: false },
    { id: 'TXN004', accountId: 'ACC003', type: 'debit', amount: 5500.00, currency: 'USD', merchant: 'Wire Transfer', location: 'NG', timestamp: '2026-01-06T03:22:00Z', riskScore: 85, flagged: true },
    { id: 'TXN005', accountId: 'ACC004', type: 'transfer', amount: 150000.00, currency: 'USD', recipient: 'Offshore Holdings', location: 'KY', timestamp: '2026-01-06T02:45:00Z', riskScore: 95, flagged: true },
    { id: 'TXN006', accountId: 'ACC001', type: 'credit', amount: 3200.00, currency: 'USD', merchant: 'Payroll', location: 'US', timestamp: '2026-01-05T00:00:00Z', riskScore: 2, flagged: false },
    { id: 'TXN007', accountId: 'ACC004', type: 'debit', amount: 95000.00, currency: 'USD', merchant: 'Crypto Exchange', location: 'MT', timestamp: '2026-01-06T04:10:00Z', riskScore: 92, flagged: true },
];

const FLAGGED: string[] = [];
const REPORTS: Array<{ id: string; type: string; summary: string }> = [];

// =============================================================================
// Tool Definitions
// =============================================================================

const scanTransactions = tool(
    ({ accountId, minAmount, riskThreshold }) => {
        let txns = [...TRANSACTIONS];
        if (accountId) txns = txns.filter(t => t.accountId === accountId);
        if (minAmount) txns = txns.filter(t => t.amount >= minAmount);
        if (riskThreshold) txns = txns.filter(t => t.riskScore >= riskThreshold);

        return JSON.stringify({
            transactions: txns.map(t => ({ ...t, holder: ACCOUNTS[t.accountId]?.holder })),
            count: txns.length,
            totalAmount: txns.reduce((sum, t) => sum + t.amount, 0),
            highRiskCount: txns.filter(t => t.riskScore >= 70).length,
        });
    },
    {
        name: 'scan_transactions',
        description: 'Scan and filter transactions based on criteria.',
        schema: z.object({
            accountId: z.string().optional(),
            minAmount: z.number().optional(),
            riskThreshold: z.number().optional(),
        }),
    }
);

const flagSuspicious = tool(
    ({ transactionId, reason, severity }) => {
        const txn = TRANSACTIONS.find(t => t.id === transactionId);
        if (!txn) return JSON.stringify({ error: `Transaction ${transactionId} not found` });

        txn.flagged = true;
        FLAGGED.push(transactionId);

        return JSON.stringify({
            success: true,
            transactionId,
            amount: txn.amount,
            reason,
            severity,
            message: `Transaction ${transactionId} flagged for review`,
        });
    },
    {
        name: 'flag_suspicious',
        description: 'Flag a transaction as suspicious for human review.',
        schema: z.object({
            transactionId: z.string(),
            reason: z.string(),
            severity: z.enum(['low', 'medium', 'high', 'critical']),
        }),
    }
);

const getAccountHistory = tool(
    ({ accountId }) => {
        const account = ACCOUNTS[accountId];
        if (!account) return JSON.stringify({ error: `Account ${accountId} not found` });

        const txns = TRANSACTIONS.filter(t => t.accountId === accountId);
        return JSON.stringify({
            account,
            recentActivity: txns,
            transactionCount: txns.length,
            flaggedCount: txns.filter(t => t.flagged).length,
        });
    },
    {
        name: 'get_account_history',
        description: 'Get account details and transaction history.',
        schema: z.object({ accountId: z.string() }),
    }
);

const generateReport = tool(
    ({ reportType, minRiskScore }) => {
        let data: Record<string, unknown>;
        let summary: string;

        switch (reportType) {
            case 'high_risk_transactions':
                const highRisk = TRANSACTIONS.filter(t => t.riskScore >= (minRiskScore || 70));
                data = { transactions: highRisk, count: highRisk.length };
                summary = `Found ${highRisk.length} high-risk transactions`;
                break;
            case 'suspicious_accounts':
                const suspicious = Object.values(ACCOUNTS).filter(a => a.riskLevel === 'high');
                data = { accounts: suspicious, count: suspicious.length };
                summary = `Identified ${suspicious.length} suspicious accounts`;
                break;
            case 'daily_summary':
                data = {
                    total: TRANSACTIONS.length,
                    flagged: TRANSACTIONS.filter(t => t.flagged).length,
                    highRisk: TRANSACTIONS.filter(t => t.riskScore >= 70).length,
                };
                summary = `Daily summary: ${TRANSACTIONS.length} transactions, ${data.flagged} flagged`;
                break;
            default:
                return JSON.stringify({ error: `Unknown report type: ${reportType}` });
        }

        const reportId = `RPT${String(REPORTS.length + 1).padStart(3, '0')}`;
        REPORTS.push({ id: reportId, type: reportType, summary });

        return JSON.stringify({ reportId, type: reportType, summary, data });
    },
    {
        name: 'generate_report',
        description: 'Generate a fraud monitoring report.',
        schema: z.object({
            reportType: z.enum(['high_risk_transactions', 'suspicious_accounts', 'daily_summary']),
            minRiskScore: z.number().optional(),
        }),
    }
);

const escalateCase = tool(
    ({ transactionIds, reason, urgency }) => {
        return JSON.stringify({
            escalationId: `ESC${Date.now()}`,
            transactionIds,
            reason,
            urgency,
            status: 'pending_review',
            assignedTo: 'compliance_team',
        });
    },
    {
        name: 'escalate_case',
        description: 'Escalate suspicious transactions to compliance team.',
        schema: z.object({
            transactionIds: z.array(z.string()),
            reason: z.string(),
            urgency: z.enum(['low', 'medium', 'high', 'critical']),
        }),
    }
);

const tools = [scanTransactions, flagSuspicious, getAccountHistory, generateReport, escalateCase];

// =============================================================================
// Demo Runner
// =============================================================================

async function runFraudMonitorDemo(): Promise<void> {
    console.log(`\n${'='.repeat(70)}`);
    console.log('🔍 FRAUD MONITOR EXAMPLE');
    console.log('   Transaction Monitoring with Veto LOG Mode');
    console.log('='.repeat(70));

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        console.error('\n❌ Error: GEMINI_API_KEY not set');
        process.exit(1);
    }
    process.env.GOOGLE_API_KEY = apiKey;

    console.log('\n🛡️  Initializing Veto in LOG mode...');
    console.log('   (All tool calls logged but NOT blocked)');
    const veto = await Veto.init({ mode: 'log' });
    const wrappedTools = veto.wrap(tools);
    console.log('   ✓ Veto initialized\n');

    console.log('🧠 Creating LangChain agent...');
    const agent = createAgent({
        model: `google-genai:gemini-3-flash-preview`,
        tools: wrappedTools,
    });
    console.log('   ✓ Agent ready\n');

    const testPrompts = [
        'Scan all transactions with a risk score above 70',
        'Analyze account history for ACC004 - looks suspicious',
        'Flag transaction TXN005 as suspicious - large offshore transfer',
        'Generate a daily summary report',
        'Escalate TXN005 and TXN007 to compliance with critical urgency',
        'Find all transactions over $50,000',
        'Generate a report of high-risk transactions',
    ];

    console.log('='.repeat(70));
    console.log('🧪 RUNNING SCENARIOS (LOG mode - observe only)');
    console.log('='.repeat(70));

    for (let i = 0; i < testPrompts.length; i++) {
        const prompt = testPrompts[i];
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`📝 [${i + 1}] ${prompt}`);
        console.log('─'.repeat(70));

        try {
            const result = await agent.invoke({
                messages: [{ role: 'user', content: prompt }],
            });
            const lastMessage = result.messages[result.messages.length - 1];
            console.log(`\n🤖 ${lastMessage.content}`);
        } catch (error) {
            console.log(`\n⚠️  Error: ${error}`);
        }
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log('🏁 Demo Complete!');
    console.log('='.repeat(70));

    console.log(`\n📊 Audit Trail Summary:`);
    console.log(`   Tool calls logged: ${veto.getHistoryStats().totalCalls}`);
    console.log(`   Transactions flagged: ${FLAGGED.length}`);
    console.log(`   Reports generated: ${REPORTS.length}`);

    console.log(`\n💡 LOG mode insight:`);
    console.log(`   All calls observed without blocking - ideal for compliance auditing`);
}

runFraudMonitorDemo().catch(console.error);
