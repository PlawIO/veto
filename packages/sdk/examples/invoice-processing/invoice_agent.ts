/**
 * Invoice Processing Agent Example (TypeScript)
 *
 * Automated invoice validation and payment scheduling
 * with Veto guardrails enforcing spend limits.
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
// Simulated Invoice & Vendor Data
// =============================================================================

interface Vendor {
    id: string;
    name: string;
    status: 'verified' | 'pending' | 'suspended';
    paymentTerms: number;
    totalPaid: number;
}

interface Invoice {
    id: string;
    vendorId: string;
    amount: number;
    description: string;
    status: 'pending' | 'approved' | 'paid' | 'rejected';
    purchaseOrderId: string | null;
    dueDate: string;
    submittedDate: string;
}

const VENDORS: Record<string, Vendor> = {
    'VND001': { id: 'VND001', name: 'Office Supplies Co', status: 'verified', paymentTerms: 30, totalPaid: 45000 },
    'VND002': { id: 'VND002', name: 'Cloud Services Inc', status: 'verified', paymentTerms: 15, totalPaid: 125000 },
    'VND003': { id: 'VND003', name: 'New Vendor LLC', status: 'pending', paymentTerms: 30, totalPaid: 0 },
    'VND004': { id: 'VND004', name: 'Suspended Corp', status: 'suspended', paymentTerms: 30, totalPaid: 5000 },
};

const INVOICES: Record<string, Invoice> = {
    'INV001': { id: 'INV001', vendorId: 'VND001', amount: 2500, description: 'Office supplies Q1', status: 'pending', purchaseOrderId: 'PO-1234', dueDate: '2026-02-15', submittedDate: '2026-01-05' },
    'INV002': { id: 'INV002', vendorId: 'VND002', amount: 15000, description: 'Cloud hosting January', status: 'pending', purchaseOrderId: 'PO-5678', dueDate: '2026-01-20', submittedDate: '2026-01-06' },
    'INV003': { id: 'INV003', vendorId: 'VND003', amount: 8500, description: 'Consulting services', status: 'pending', purchaseOrderId: null, dueDate: '2026-02-01', submittedDate: '2026-01-06' },
    'INV004': { id: 'INV004', vendorId: 'VND001', amount: 750, description: 'Printer supplies', status: 'pending', purchaseOrderId: null, dueDate: '2026-02-10', submittedDate: '2026-01-06' },
};

const PROCESSED_INVOICES: string[] = [];

// =============================================================================
// Tool Definitions
// =============================================================================

const getInvoice = tool(
    ({ invoiceId }) => {
        const invoice = INVOICES[invoiceId];
        if (!invoice) return JSON.stringify({ error: `Invoice ${invoiceId} not found` });

        const vendor = VENDORS[invoice.vendorId];
        return JSON.stringify({
            ...invoice,
            vendorName: vendor?.name,
            vendorStatus: vendor?.status,
        });
    },
    {
        name: 'get_invoice',
        description: 'Get invoice details by ID.',
        schema: z.object({ invoiceId: z.string() }),
    }
);

const listInvoices = tool(
    ({ status }) => {
        let invoices = Object.values(INVOICES);
        if (status) invoices = invoices.filter(i => i.status === status);

        return JSON.stringify({
            invoices: invoices.map(i => ({
                id: i.id,
                vendor: VENDORS[i.vendorId]?.name,
                amount: i.amount,
                status: i.status,
                dueDate: i.dueDate,
            })),
            count: invoices.length,
            totalAmount: invoices.reduce((sum, i) => sum + i.amount, 0),
        });
    },
    {
        name: 'list_invoices',
        description: 'List invoices, optionally filtered by status.',
        schema: z.object({
            status: z.enum(['pending', 'approved', 'paid', 'rejected']).optional(),
        }),
    }
);

const getVendor = tool(
    ({ vendorId }) => {
        const vendor = VENDORS[vendorId];
        if (!vendor) return JSON.stringify({ error: `Vendor ${vendorId} not found` });
        return JSON.stringify(vendor);
    },
    {
        name: 'get_vendor',
        description: 'Get vendor details.',
        schema: z.object({ vendorId: z.string() }),
    }
);

const approveInvoice = tool(
    ({ invoiceId, amount, purchaseOrderId, managerApproval }) => {
        const invoice = INVOICES[invoiceId];
        if (!invoice) return JSON.stringify({ error: `Invoice ${invoiceId} not found` });

        invoice.status = 'approved';

        return JSON.stringify({
            success: true,
            invoiceId,
            amount,
            status: 'approved',
            purchaseOrderId,
            managerApproval,
            message: `Invoice ${invoiceId} approved for $${amount}`,
        });
    },
    {
        name: 'approve_invoice',
        description: 'Approve an invoice for payment.',
        schema: z.object({
            invoiceId: z.string(),
            amount: z.number(),
            purchaseOrderId: z.string().nullable(),
            managerApproval: z.boolean(),
        }),
    }
);

const schedulePayment = tool(
    ({ invoiceId, amount, paymentDate }) => {
        const invoice = INVOICES[invoiceId];
        if (!invoice) return JSON.stringify({ error: `Invoice ${invoiceId} not found` });

        const vendor = VENDORS[invoice.vendorId];
        invoice.status = 'paid';
        PROCESSED_INVOICES.push(invoiceId);

        return JSON.stringify({
            success: true,
            invoiceId,
            vendorName: vendor?.name,
            amount,
            paymentDate,
            message: `Payment of $${amount} scheduled for ${paymentDate}`,
        });
    },
    {
        name: 'schedule_payment',
        description: 'Schedule payment for an approved invoice.',
        schema: z.object({
            invoiceId: z.string(),
            amount: z.number(),
            paymentDate: z.string(),
        }),
    }
);

const rejectInvoice = tool(
    ({ invoiceId, reason }) => {
        const invoice = INVOICES[invoiceId];
        if (!invoice) return JSON.stringify({ error: `Invoice ${invoiceId} not found` });

        invoice.status = 'rejected';

        return JSON.stringify({
            success: true,
            invoiceId,
            status: 'rejected',
            reason,
        });
    },
    {
        name: 'reject_invoice',
        description: 'Reject an invoice.',
        schema: z.object({
            invoiceId: z.string(),
            reason: z.string(),
        }),
    }
);

const tools = [getInvoice, listInvoices, getVendor, approveInvoice, schedulePayment, rejectInvoice];

// =============================================================================
// Demo Runner
// =============================================================================

async function runInvoiceDemo(): Promise<void> {
    console.log(`\n${'='.repeat(70)}`);
    console.log('📄 INVOICE PROCESSING AGENT EXAMPLE');
    console.log('   Automated Invoice Validation with Veto Guardrails');
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
        'List all pending invoices',
        'Get details for invoice INV001',
        'Approve invoice INV001 for $2500 with PO-1234, manager approved',
        'Approve invoice INV002 for $15000 without manager approval',  // BLOCKED - large amount
        'Approve invoice INV003 for $8500 without PO',  // BLOCKED - no PO for large invoice
        'Schedule payment for INV001 for $2500 on 2026-01-15',
        'Get vendor details for VND003',
        'Reject invoice INV003 - vendor not verified',
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

runInvoiceDemo().catch(console.error);
