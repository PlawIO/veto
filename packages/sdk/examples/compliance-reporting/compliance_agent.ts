/**
 * Compliance Reporting Agent Example (TypeScript)
 *
 * Regulatory compliance reporting with Veto guardrails
 * controlling data exports and sensitive operations.
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
// Simulated Compliance Data
// =============================================================================

interface ComplianceReport {
    id: string;
    type: string;
    generatedAt: string;
    status: 'draft' | 'final' | 'submitted';
    includesPII: boolean;
    destination: 'internal' | 'external';
}

interface AuditEntry {
    id: string;
    action: string;
    user: string;
    timestamp: string;
    details: string;
}

const REPORTS: ComplianceReport[] = [
    { id: 'RPT001', type: 'SOC2', generatedAt: '2026-01-01', status: 'final', includesPII: false, destination: 'internal' },
    { id: 'RPT002', type: 'GDPR', generatedAt: '2025-12-15', status: 'submitted', includesPII: true, destination: 'external' },
    { id: 'RPT003', type: 'HIPAA', generatedAt: '2026-01-05', status: 'draft', includesPII: true, destination: 'internal' },
];

const AUDIT_LOG: AuditEntry[] = [
    { id: 'AUD001', action: 'report_generated', user: 'system', timestamp: '2026-01-06T10:00:00Z', details: 'SOC2 Q4 report' },
    { id: 'AUD002', action: 'data_export', user: 'analyst', timestamp: '2026-01-06T11:30:00Z', details: 'Customer metrics export' },
    { id: 'AUD003', action: 'pii_access', user: 'compliance_officer', timestamp: '2026-01-06T14:00:00Z', details: 'GDPR data review' },
];

// =============================================================================
// Tool Definitions
// =============================================================================

const listReports = tool(
    ({ status }) => {
        let reports = REPORTS;
        if (status) reports = reports.filter(r => r.status === status);

        return JSON.stringify({
            reports: reports.map(r => ({
                id: r.id,
                type: r.type,
                status: r.status,
                generatedAt: r.generatedAt,
            })),
            count: reports.length,
        });
    },
    {
        name: 'list_reports',
        description: 'List compliance reports.',
        schema: z.object({
            status: z.enum(['draft', 'final', 'submitted']).optional(),
        }),
    }
);

const generateReport = tool(
    ({ reportType, includesPII, destination }) => {
        const reportId = `RPT${String(REPORTS.length + 1).padStart(3, '0')}`;
        const report: ComplianceReport = {
            id: reportId,
            type: reportType,
            generatedAt: new Date().toISOString().split('T')[0],
            status: 'draft',
            includesPII,
            destination,
        };
        REPORTS.push(report);

        AUDIT_LOG.push({
            id: `AUD${String(AUDIT_LOG.length + 1).padStart(3, '0')}`,
            action: 'report_generated',
            user: 'ai_agent',
            timestamp: new Date().toISOString(),
            details: `Generated ${reportType} report`,
        });

        return JSON.stringify({
            success: true,
            reportId,
            type: reportType,
            status: 'draft',
            message: `${reportType} report generated`,
        });
    },
    {
        name: 'generate_report',
        description: 'Generate a compliance report.',
        schema: z.object({
            reportType: z.enum(['SOC2', 'GDPR', 'HIPAA', 'PCI-DSS']),
            includesPII: z.boolean(),
            destination: z.enum(['internal', 'external']),
        }),
    }
);

const queryData = tool(
    ({ dataType, classification, destination }) => {
        return JSON.stringify({
            success: true,
            dataType,
            classification,
            destination,
            recordCount: 1250,
            message: `Queried ${dataType} data`,
        });
    },
    {
        name: 'query_data',
        description: 'Query compliance data.',
        schema: z.object({
            dataType: z.string(),
            classification: z.enum(['public', 'internal', 'confidential', 'top-secret']),
            destination: z.enum(['internal', 'external']),
        }),
    }
);

const exportData = tool(
    ({ dataType, format, destination, includesPII, piiApproval }) => {
        return JSON.stringify({
            success: true,
            dataType,
            format,
            destination,
            includesPII,
            piiApproval,
            exportId: `EXP${Date.now()}`,
            message: `Data exported to ${destination}`,
        });
    },
    {
        name: 'export_data',
        description: 'Export compliance data.',
        schema: z.object({
            dataType: z.string(),
            format: z.enum(['csv', 'json', 'pdf']),
            destination: z.enum(['internal', 'external']),
            includesPII: z.boolean(),
            piiApproval: z.boolean(),
        }),
    }
);

const getAuditLog = tool(
    ({ limit }) => {
        const entries = AUDIT_LOG.slice(-(limit || 10));
        return JSON.stringify({
            entries,
            count: entries.length,
        });
    },
    {
        name: 'get_audit_log',
        description: 'Get audit log entries.',
        schema: z.object({ limit: z.number().optional() }),
    }
);

const tools = [listReports, generateReport, queryData, exportData, getAuditLog];

// =============================================================================
// Demo Runner
// =============================================================================

async function runComplianceDemo(): Promise<void> {
    console.log(`\n${'='.repeat(70)}`);
    console.log('📋 COMPLIANCE REPORTING AGENT EXAMPLE');
    console.log('   Data Export Controls with Veto Guardrails');
    console.log('='.repeat(70));

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        console.error('\n❌ Error: GEMINI_API_KEY not set');
        process.exit(1);
    }
    process.env.GOOGLE_API_KEY = apiKey;

    console.log('\n🛡️  Initializing Veto guardrails...');
    const veto = await Veto.init();
    const wrappedTools = veto.wrap(tools);
    console.log('   ✓ Veto initialized\n');

    console.log('🧠 Creating LangChain agent...');
    const agent = createAgent({
        model: `google-genai:gemini-3-flash-preview`,
        tools: wrappedTools,
    });
    console.log('   ✓ Agent ready\n');

    const testPrompts = [
        'List all compliance reports',
        'Generate an internal SOC2 report without PII',
        'Query internal customer data with confidential classification',
        'Query top-secret employee data',  // BLOCKED - top-secret
        'Export customer data as CSV internally with PII and approval',
        'Export customer data with PII but no approval',  // BLOCKED - no approval
        'Export data to external destination',  // BLOCKED - external
        'Get the audit log',
    ];

    console.log('='.repeat(70));
    console.log('🧪 RUNNING SCENARIOS');
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
    console.log(veto.getHistoryStats());
}

runComplianceDemo().catch(console.error);
