#!/bin/bash
# Build a self-contained diskusage.plg from source/
# The generated .plg embeds the whole plugin payload as base64 (tar.gz),
# so installation is a single file:  plugin install ./diskusage.plg
#
# usage: ./build.sh [version]        (AUTHOR="name" ./build.sh 2026.09.23)
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-$(date +%Y.%m.%d)}"
AUTHOR="${AUTHOR:-lucien}"
PLUGIN="diskusage"
SRC="source/usr/local/emhttp/plugins/$PLUGIN"
OUT="$PLUGIN.plg"

[ -d "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# stage payload mirroring the on-server layout
mkdir -p "$TMP/usr/local/emhttp/plugins"
cp -R "$SRC" "$TMP/usr/local/emhttp/plugins/"
find "$TMP" \( -name '.DS_Store' -o -name '._*' -o -name '*~' -o -name '*.swp' \) -delete

# normalize CRLF (harmless if already LF)
if command -v perl >/dev/null 2>&1; then
    find "$TMP" -type f -exec perl -pi -e 's/\r\n/\n/g' {} +
fi

# event hooks and scripts must be executable after extraction
find "$TMP/usr/local/emhttp/plugins/$PLUGIN/event" -type f -exec chmod 755 {} +
find "$TMP/usr/local/emhttp/plugins/$PLUGIN/scripts" -type f -name '*.sh' -exec chmod 755 {} +

tar -czf "$TMP/pkg.tar.gz" -C "$TMP" usr
B64=$(base64 < "$TMP/pkg.tar.gz" | tr -d '\n')
echo "payload: $(wc -c < "$TMP/pkg.tar.gz" | tr -d ' ') bytes gz -> $(( ${#B64} / 1024 )) KB base64"

cat > "$OUT" <<EOF
<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
<!ENTITY name        "$PLUGIN">
<!ENTITY author      "$AUTHOR">
<!ENTITY version     "$VERSION">
<!ENTITY launch      "Settings/$PLUGIN">
<!ENTITY pluginLOC   "/boot/config/plugins/&name;">
<!ENTITY emhttpLOC   "/usr/local/emhttp/plugins/&name;">
]>

<PLUGIN  name="&name;"
         author="&author;"
         version="&version;"
         launch="&launch;"
         icon="pie-chart"
         min="6.9.0"
>

<CHANGES>
### $VERSION
- WinDirStat-style treemap, folder tree, extension legend, largest files
- Background scanner with live progress (find + awk, GNU/BSD compatible)
- Allocated vs apparent size toggle
</CHANGES>

<!-- clean previous install (runs on install AND update) -->
<FILE Run="/bin/bash">
<INLINE>
rm -rf &emhttpLOC;
rm -f &pluginLOC;/&name;-pkg.tar.gz;
mkdir -p &pluginLOC;
exit 0
</INLINE>
</FILE>

<!-- self-contained payload -->
<FILE Name="&pluginLOC;/&name;-pkg.tar.gz" Type="base64">
<INLINE>
$B64
</INLINE>
</FILE>

<!-- extract payload -->
<FILE Run="/bin/bash">
<INLINE>
tar -xzf &pluginLOC;/&name;-pkg.tar.gz -C / || exit 1
rm -f &pluginLOC;/&name;-pkg.tar.gz
chmod +x &emhttpLOC;/scripts/*.sh &emhttpLOC;/event/* 2>/dev/null || true
echo ""
echo "----------------------------------------------------"
echo " &name; &version; installed."
echo " Open Settings -> Disk Usage in the webGUI."
echo "----------------------------------------------------"
echo ""
exit 0
</INLINE>
</FILE>

<!-- remove -->
<FILE Run="/bin/bash" Method="remove">
<INLINE>
rm -rf &emhttpLOC;
rm -rf &pluginLOC;
echo ""
echo "----------------------------------------------------"
echo " &name; has been removed."
echo "----------------------------------------------------"
echo ""
exit 0
</INLINE>
</FILE>

</PLUGIN>
EOF

if command -v xmllint >/dev/null 2>&1; then
    xmllint --noout "$OUT"
    echo "XML validation: OK"
fi
echo "built $OUT ($VERSION)"
