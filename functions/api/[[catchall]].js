/**
 * Cloudflare Worker to proxy WB Board Result API calls, handle referrals, and payment verification.
 * Handles requests to /api/details and /api/full-result
 */

// --- Configuration ---
const PAYMENT_DB_URL = 'https://warisha.pw/payments'; // Replace with your actual payment DB URL
const BOARD_API_BASE_URL = 'https://boardresultapi.abplive.com/wb/2025/12'; // Base URL remains, roll/reg will be appended

// --- START: Referral Configuration (Moved to Backend) ---
const referralButtonMap = {
    'subhra': 'pl_QRCx74QvShiAil', // Button ID for Subhra
    'koyel': 'pl_QMWdxwIPVZYTpi',   // Button ID for Koyel
    'anwesha': 'pl_QRfw57xno82GiV'   // Button ID for Anwesha
    // Add more friends here: 'friendname': 'button_id'
};
const defaultRazorpayButtonId = 'pl_QMXOuva67vyoan'; // Your original default ID
// --- END: Referral Configuration ---


// --- CORS Headers ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // Consider restricting this in production: e.g., 'https://yourdomain.com'
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// --- Main Handler ---
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    try {
        if (url.pathname === '/api/details') {
            return await handleDetailsRequest(request, env);
        } else if (url.pathname === '/api/full-result') {
            return await handleFullResultRequest(request, env);
        } else {
            return new Response(JSON.stringify({ message: 'Not Found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    } catch (error) {
        console.error(`Worker Error on ${url.pathname}:`, error);
        const errorMessage = (error instanceof Error) ? error.message : 'Internal Server Error';
        return new Response(JSON.stringify({ message: errorMessage }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}


// --- Handler for Basic Details (Now with Referral Logic & Registration Number) ---
async function handleDetailsRequest(request, env) {
    let requestData;
    try {
        requestData = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Read roll, no, registration, and referralKey ---
    const { roll, no, registration, referralKey } = requestData;

    // Updated validation to include registration
    if (!roll || !no || !registration || !/^\d{6}$/.test(roll) || !/^\d{4}$/.test(no) || typeof registration !== 'string' || registration.trim() === '') {
        return new Response(JSON.stringify({ message: 'Invalid Roll, No, or Registration Number format. All fields are required.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let paymentButtonIdToUse = defaultRazorpayButtonId;
    if (referralKey && referralButtonMap[referralKey.toLowerCase()]) {
        paymentButtonIdToUse = referralButtonMap[referralKey.toLowerCase()];
    }

    const fullRoll = roll + no; // This is the 'rollNumber' part of the API path
    // Updated API URL format
    const apiUrl = `${BOARD_API_BASE_URL}/${fullRoll}/${registration.trim()}`;

    try {
        const apiResponse = await fetch(apiUrl);

        if (!apiResponse.ok) {
            let errorText = `API Error (${apiResponse.status}): ${apiResponse.statusText}`;
            try {
                const errorJson = await apiResponse.json();
                errorText = errorJson.message || errorText;
            } catch (e) { /* Ignore if response isn't JSON */ }

            return new Response(JSON.stringify({ message: errorText }), {
                status: apiResponse.status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const data = await apiResponse.json();

        const responsePayload = {
            name: data.name,
            rollNo: data.ROll_No, // Assuming ROll_No is the correct field from API
            regNo: data.Reg_No,   // Assuming Reg_No is the correct field from API
            paymentButtonId: paymentButtonIdToUse
        };

        return new Response(JSON.stringify(responsePayload), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error fetching from board API (details):', error);
        return new Response(JSON.stringify({ message: 'Failed to connect to the results service.' }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}


// --- Handler for Full Result (with Payment/Identifier Verification & Registration Number) ---
async function handleFullResultRequest(request, env) {
    let requestData;
    try {
        requestData = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Read identifier, roll, no, and new registration number ---
    const { identifier, roll, no, registration } = requestData;

    // Updated validation to include registration
    if (!identifier || !roll || !no || !registration || !/^\d{6}$/.test(roll) || !/^\d{4}$/.test(no) || typeof registration !== 'string' || registration.trim() === '') {
        return new Response(JSON.stringify({ message: 'Invalid Identifier (Payment ID/Email/Phone), Roll, No, or Registration Number format. All fields are required.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Step 1: Verify Identifier, Roll, and No against Payment DB (Unchanged) ---
    try {
        const paymentDbResponse = await fetch(PAYMENT_DB_URL, {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
        });

        if (!paymentDbResponse.ok) {
            console.error(`Failed to fetch payment DB: ${paymentDbResponse.status} ${paymentDbResponse.statusText}`);
            return new Response(JSON.stringify({ message: 'Could not verify details at this time (DB Error).' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const paymentData = await paymentDbResponse.json();

        if (!Array.isArray(paymentData)) {
            console.error('Payment data is not an array:', paymentData);
            return new Response(JSON.stringify({ message: 'Payment data format error.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const normalizedIdentifier = identifier.toLowerCase();
        const isValidPayment = paymentData.some(record =>
            record.roll === roll &&
            record.no === no &&
            (
                (record.payment_id && record.payment_id.toLowerCase() === normalizedIdentifier) ||
                (record.email && record.email.toLowerCase() === normalizedIdentifier) ||
                (record.phone && record.phone === identifier)
            )
        );

        if (!isValidPayment) {
            return new Response(JSON.stringify({ message: 'Verification failed. Payment not found or details mismatch.' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

    } catch (error) {
        console.error('Error verifying payment:', error);
        return new Response(JSON.stringify({ message: 'Error during payment verification.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Step 2: If verification passed, fetch the full result using new API format ---
    const fullRoll = roll + no; // This is the 'rollNumber' part of the API path
    // Updated API URL format
    const apiUrl = `${BOARD_API_BASE_URL}/${fullRoll}/${registration.trim()}`;

    try {
        const apiResponse = await fetch(apiUrl);

        if (!apiResponse.ok) {
            let errorText = `API Error (${apiResponse.status}): ${apiResponse.statusText}`;
            try {
                const errorJson = await apiResponse.json();
                errorText = errorJson.message || errorText;
            } catch (e) { /* Ignore */ }

            if (apiResponse.status === 404) {
                errorText = 'Result found (payment verified), but could not retrieve full details with the provided Roll, No, and Registration Number. Please check these details or contact support.';
            }

            return new Response(JSON.stringify({ message: errorText }), {
                status: apiResponse.status === 404 ? 500 : apiResponse.status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const resultData = await apiResponse.json();

        return new Response(JSON.stringify(resultData), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error fetching from board API (full result):', error);
        return new Response(JSON.stringify({ message: 'Failed to connect to the results service for full details.' }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}