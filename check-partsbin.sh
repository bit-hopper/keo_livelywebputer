#!/bin/bash

# PartsBin Recovery Script
# Verifies and rebuilds DAV database indexing for PartsBin

set -e

echo "🔧 LivelyKernel PartsBin Recovery"
echo "=================================="
echo ""

# Check if PartsBin exists
if [ ! -d "PartsBin" ]; then
    echo "❌ PartsBin directory not found"
    exit 1
fi

echo "✓ PartsBin directory exists"

# Count PartsBin files
PART_COUNT=$(find PartsBin -type f \( -name "*.json" -o -name "*.html" -o -name "*.metainfo" \) | wc -l)
echo "✓ Found $PART_COUNT PartsBin files"

# Check DAV database
if [ -f "objects-identity.sqlite" ]; then
    echo "✓ DAV database exists (objects-identity.sqlite)"
    
    # Check if database has records
    DB_RECORDS=$(sqlite3 objects-identity.sqlite "SELECT COUNT(*) FROM versioned_objects;" 2>/dev/null || echo "0")
    echo "  → Database contains $DB_RECORDS versioned objects"
    
    if [ "$DB_RECORDS" -eq 0 ]; then
        echo "⚠️  Database is empty - PartsBin files not indexed!"
        echo ""
        echo "To fix:"
        echo "  1. Restart server (will re-scan PartsBin)"
        echo "  2. Or manually reset: rm objects-identity.sqlite && npm start"
    fi
else
    echo "⚠️  DAV database not found (will be created on startup)"
fi

echo ""
echo "✓ PartsBin status checked successfully"
echo ""
echo "Next steps:"
echo "  1. If errors persist, restart the server:"
echo "     npm start"
echo "  2. Monitor startup logs for 'PartsBin' messages"
echo "  3. Verify Procfile has no --no-partsbin-check flag"
