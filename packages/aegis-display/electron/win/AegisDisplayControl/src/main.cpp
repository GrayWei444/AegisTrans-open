// AegisDisplayControl — CLI entrypoint
//
// Windows counterpart of the Mac AegisDisplayHelper. Spawned by
// ../../../src/plugin.ts (win32 branch) via child_process.
//
// JSON RPC contract (identical schema to Mac's AegisDisplayHelper):
//
//   AegisDisplayControl.exe status
//     -> stdout JSON: { "supported": bool, "enabled": bool, "reason"?: string,
//                        "displayId"?: string, "resolution"?: string }
//     -> exit 0 always (status query never fails)
//
//   AegisDisplayControl.exe enable --resolution 2560x1440
//     -> tells the installed AegisDisplay IddCx driver to attach a monitor
//     -> stdout JSON status, exit 0
//     -> RETURNS IMMEDIATELY. Unlike Mac, the virtual display lives in the
//        installed driver, not in this process. There is no blocking runloop.
//
//   AegisDisplayControl.exe disable
//     -> tells the driver to detach the monitor
//     -> stdout JSON status, exit 0
//
// Resolution profiles allowed: 1920x1080, 2560x1440, 3840x2160.
//
// IPC design (Phase 3, 2026-05-17):
//   - state file: C:\AegisDisplay\vdd_settings.xml (driver reads, we read+write)
//   - reload trigger: \\.\pipe\AegisDisplayPipe — write L"RELOAD_DRIVER" + close
//   - presence: HKLM\SYSTEM\CurrentControlSet\Services\AegisDisplay (service entry)

#include <windows.h>

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

// --- Constants ---------------------------------------------------------------
constexpr const wchar_t* kPipeName       = L"\\\\.\\pipe\\AegisDisplayPipe";
constexpr const wchar_t* kSettingsDir    = L"C:\\AegisDisplay";
constexpr const wchar_t* kSettingsPath   = L"C:\\AegisDisplay\\vdd_settings.xml";
constexpr const wchar_t* kDriverStoreGlob = L"C:\\Windows\\System32\\DriverStore\\FileRepository\\aegisdisplay.inf_*";
constexpr const wchar_t* kReloadCommand  = L"RELOAD_DRIVER";

// Minimal default settings written on first `enable` if the file is absent.
// Mirrors the upstream vdd_settings.xml schema but trims to what the driver
// actually consumes for Phase 3 (monitor count + one resolution + logging off).
constexpr const char* kDefaultSettingsXml =
    "<?xml version='1.0' encoding='utf-8'?>\n"
    "<vdd_settings>\n"
    "    <monitors><count>0</count></monitors>\n"
    "    <gpu><friendlyname>default</friendlyname></gpu>\n"
    "    <global>\n"
    "        <g_refresh_rate>60</g_refresh_rate>\n"
    "    </global>\n"
    "    <resolutions>\n"
    "        <resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution>\n"
    "    </resolutions>\n"
    "    <logging>\n"
    "        <SendLogsThroughPipe>true</SendLogsThroughPipe>\n"
    "        <logging>false</logging>\n"
    "        <debuglogging>false</debuglogging>\n"
    "    </logging>\n"
    "    <colour>\n"
    "        <SDR10bit>false</SDR10bit>\n"
    "        <HDRPlus>false</HDRPlus>\n"
    "        <ColourFormat>RGB</ColourFormat>\n"
    "    </colour>\n"
    "</vdd_settings>\n";

// --- Status model ------------------------------------------------------------
// Mirrors the VirtualDisplayStatus interface in ../../src/index.ts.
struct VirtualDisplayStatus {
    bool supported = false;
    bool enabled = false;
    std::string reason;      // optional — emitted only when non-empty
    std::string displayId;   // optional — emitted only when non-empty
    std::string resolution;  // optional — emitted only when non-empty
};

// --- JSON output (hand-rolled — no third-party deps) -------------------------
std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:   out += c;      break;
        }
    }
    return out;
}

void emitJSON(const VirtualDisplayStatus& s) {
    std::string out = "{";
    out += "\"supported\":";
    out += s.supported ? "true" : "false";
    out += ",\"enabled\":";
    out += s.enabled ? "true" : "false";
    if (!s.reason.empty())     out += ",\"reason\":\"" + jsonEscape(s.reason) + "\"";
    if (!s.displayId.empty())  out += ",\"displayId\":\"" + jsonEscape(s.displayId) + "\"";
    if (!s.resolution.empty()) out += ",\"resolution\":\"" + jsonEscape(s.resolution) + "\"";
    out += "}";
    std::cout << out << "\n";
    std::cout.flush();
}

void emitError(const std::string& msg) {
    std::cerr << "AegisDisplayControl: " << msg << "\n";
}

// --- Resolution validation ---------------------------------------------------
bool isValidResolution(const std::string& r) {
    return r == "1920x1080" || r == "2560x1440" || r == "3840x2160";
}

void parseResolution(const std::string& r, int& w, int& h) {
    // Validated by isValidResolution before we get here.
    size_t x = r.find('x');
    w = std::stoi(r.substr(0, x));
    h = std::stoi(r.substr(x + 1));
}

// --- Driver IPC --------------------------------------------------------------
namespace driver {

bool isInstalled() {
    // The UMDF service is "WUDFRd" (kernel reflector, shared by every UMDF
    // driver) — not "AegisDisplay" — so a Services\AegisDisplay check is wrong.
    // The reliable signal is that the driver INF was staged into the driver
    // store, which creates a versioned subfolder under FileRepository.
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(kDriverStoreGlob, &fd);
    if (h == INVALID_HANDLE_VALUE) return false;
    FindClose(h);
    return true;
}

// Read the settings file as UTF-8 bytes. Returns empty string on failure.
std::string readSettingsFile() {
    std::ifstream in(kSettingsPath, std::ios::binary);
    if (!in) return {};
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

bool writeSettingsFile(const std::string& content) {
    CreateDirectoryW(kSettingsDir, nullptr);  // OK if already exists
    std::ofstream out(kSettingsPath, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(content.data(), static_cast<std::streamsize>(content.size()));
    return out.good();
}

// Replace the contents of <monitors><count>N</count></monitors>. Tolerates
// whitespace between the tags. Returns true on success (false = tag not found).
bool replaceMonitorCount(std::string& xml, int newCount) {
    const std::string openTag = "<count>";
    const std::string closeTag = "</count>";
    size_t monStart = xml.find("<monitors>");
    if (monStart == std::string::npos) return false;
    size_t monEnd = xml.find("</monitors>", monStart);
    if (monEnd == std::string::npos) return false;
    size_t openPos = xml.find(openTag, monStart);
    if (openPos == std::string::npos || openPos > monEnd) return false;
    size_t closePos = xml.find(closeTag, openPos);
    if (closePos == std::string::npos || closePos > monEnd) return false;
    size_t valStart = openPos + openTag.size();
    xml.replace(valStart, closePos - valStart, std::to_string(newCount));
    return true;
}

// Replace the entire <resolutions>...</resolutions> block with one resolution
// at 60Hz. Returns true on success.
bool replaceResolutionList(std::string& xml, int w, int h) {
    const std::string openTag = "<resolutions>";
    const std::string closeTag = "</resolutions>";
    size_t start = xml.find(openTag);
    if (start == std::string::npos) return false;
    size_t end = xml.find(closeTag, start);
    if (end == std::string::npos) return false;
    size_t bodyStart = start + openTag.size();
    std::string replacement =
        "\n        <resolution><width>" + std::to_string(w) +
        "</width><height>" + std::to_string(h) +
        "</height><refresh_rate>60</refresh_rate></resolution>\n    ";
    xml.replace(bodyStart, end - bodyStart, replacement);
    return true;
}

// Extract the current monitor count from the xml. Returns -1 if not found.
int readMonitorCount(const std::string& xml) {
    size_t monStart = xml.find("<monitors>");
    if (monStart == std::string::npos) return -1;
    size_t openPos = xml.find("<count>", monStart);
    if (openPos == std::string::npos) return -1;
    size_t valStart = openPos + 7;  // strlen("<count>")
    size_t closePos = xml.find("</count>", valStart);
    if (closePos == std::string::npos) return -1;
    try {
        return std::stoi(xml.substr(valStart, closePos - valStart));
    } catch (...) {
        return -1;
    }
}

// Extract the first <resolution> from the xml as "WxH". Returns empty if absent.
std::string readFirstResolution(const std::string& xml) {
    size_t start = xml.find("<resolutions>");
    if (start == std::string::npos) return {};
    size_t end = xml.find("</resolutions>", start);
    if (end == std::string::npos) return {};
    size_t resStart = xml.find("<resolution>", start);
    if (resStart == std::string::npos || resStart > end) return {};
    size_t wOpen = xml.find("<width>", resStart);
    if (wOpen == std::string::npos) return {};
    size_t wClose = xml.find("</width>", wOpen);
    if (wClose == std::string::npos) return {};
    size_t hOpen = xml.find("<height>", wClose);
    if (hOpen == std::string::npos) return {};
    size_t hClose = xml.find("</height>", hOpen);
    if (hClose == std::string::npos) return {};
    std::string w = xml.substr(wOpen + 7, wClose - (wOpen + 7));
    std::string h = xml.substr(hOpen + 8, hClose - (hOpen + 8));
    return w + "x" + h;
}

// Connect to the driver's named pipe and send RELOAD_DRIVER as a wide-char
// string (matches Driver.cpp's ReadFile + wcsncmp at line 2074).
// Best-effort: if the pipe is not present (driver not loaded yet), the xml
// edit alone is enough — the driver will pick it up at next load.
bool sendReload() {
    HANDLE h = CreateFileW(kPipeName, GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    // Length in bytes: 13 wide chars * 2 bytes = 26 (no trailing null — driver
    // only reads as many bytes as ReadFile returns and uses wcsncmp).
    DWORD toWrite = static_cast<DWORD>(wcslen(kReloadCommand) * sizeof(wchar_t));
    BOOL ok = WriteFile(h, kReloadCommand, toWrite, &written, nullptr);
    CloseHandle(h);
    return ok != 0 && written == toWrite;
}

// Append a line to C:\AegisDisplay\primary-reassign.log so we can debug from the user's
// machine what enable()/disable() actually saw + decided. Best-effort, swallow errors.
void logReassign(const std::string& line) {
    CreateDirectoryW(kSettingsDir, nullptr);
    HANDLE h = CreateFileW(L"C:\\AegisDisplay\\primary-reassign.log",
                           FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME st; GetLocalTime(&st);
    char ts[64];
    sprintf_s(ts, sizeof(ts), "[%04d-%02d-%02d %02d:%02d:%02d] ",
              st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    SetFilePointer(h, 0, nullptr, FILE_END);
    DWORD w;
    WriteFile(h, ts, (DWORD)strlen(ts), &w, nullptr);
    WriteFile(h, line.c_str(), (DWORD)line.size(), &w, nullptr);
    WriteFile(h, "\r\n", 2, &w, nullptr);
    CloseHandle(h);
}

const char* outputTechName(DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY t) {
    switch (t) {
        case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL: return "INTERNAL";
        case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED: return "DP_EMBEDDED";
        case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EXTERNAL: return "DP_EXTERNAL";
        case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_HDMI: return "HDMI";
        case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INDIRECT_WIRED: return "INDIRECT_WIRED";
        case DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INDIRECT_VIRTUAL: return "INDIRECT_VIRTUAL";
        default: return "OTHER";
    }
}

// Force the primary monitor to the user's real display, NOT the AegisDisplay
// virtual monitor. Detection now uses output technology (INTERNAL / DP / HDMI =
// real; INDIRECT_WIRED / INDIRECT_VIRTUAL = our virtual). Friendly-name match
// was unreliable — AegisDisplay's name is currently inherited from upstream MTT
// EDID and may or may not contain identifiable strings.
//
// Writes per-path findings to C:\AegisDisplay\primary-reassign.log for debug.
bool reassignPrimaryToRealDisplay() {
    // Retry loop: GetDisplayConfigBufferSizes + QueryDisplayConfig is a known race —
    // if the display config changes between the two calls (e.g., driver just attached
    // a monitor), QueryDisplayConfig returns ERROR_INSUFFICIENT_BUFFER. MS docs say
    // retry with fresh buffer sizes.
    UINT32 pathCount = 0, modeCount = 0;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths;
    std::vector<DISPLAYCONFIG_MODE_INFO> modes;
    LONG qrc = ERROR_INSUFFICIENT_BUFFER;
    for (int attempt = 0; attempt < 6 && qrc == ERROR_INSUFFICIENT_BUFFER; ++attempt) {
        LONG sizeRc = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount);
        if (sizeRc != ERROR_SUCCESS) {
            char err[80];
            sprintf_s(err, sizeof(err), "ERR GetDisplayConfigBufferSizes rc=%ld (attempt %d)", sizeRc, attempt);
            logReassign(err);
            return false;
        }
        paths.assign(pathCount, {});
        modes.assign(modeCount, {});
        qrc = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(),
                                 &modeCount, modes.data(), nullptr);
        if (qrc != ERROR_SUCCESS && qrc != ERROR_INSUFFICIENT_BUFFER) {
            char err[80];
            sprintf_s(err, sizeof(err), "ERR QueryDisplayConfig rc=%ld (attempt %d)", qrc, attempt);
            logReassign(err);
            return false;
        }
        if (qrc == ERROR_INSUFFICIENT_BUFFER) {
            Sleep(200);
        }
    }
    if (qrc != ERROR_SUCCESS) {
        char err[80];
        sprintf_s(err, sizeof(err), "ERR QueryDisplayConfig still ERROR_INSUFFICIENT_BUFFER after retries");
        logReassign(err);
        return false;
    }
    char hdr[128];
    sprintf_s(hdr, sizeof(hdr), "reassign START paths=%u modes=%u", pathCount, modeCount);
    logReassign(hdr);

    // Detection priority: INTERNAL output tech (laptop panel) > known-virtual names
    // > anything else. AegisDisplay (IddCx UMDF) sometimes enumerates as HDMI output
    // tech (not INDIRECT_*) — must also match by friendly name "MTT"/"VDD by MTT"/"AegisDisplay"
    // for those cases.
    int realPathIdx = -1;
    int virtualPathIdx = -1;
    for (UINT32 i = 0; i < pathCount; ++i) {
        DISPLAYCONFIG_TARGET_DEVICE_NAME targetName{};
        targetName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
        targetName.header.size = sizeof(targetName);
        targetName.header.adapterId = paths[i].targetInfo.adapterId;
        targetName.header.id = paths[i].targetInfo.id;
        bool gotName = DisplayConfigGetDeviceInfo(&targetName.header) == ERROR_SUCCESS;

        char nameUtf8[128] = "(no-name)";
        if (gotName && targetName.monitorFriendlyDeviceName[0]) {
            WideCharToMultiByte(CP_UTF8, 0, targetName.monitorFriendlyDeviceName, -1,
                                nameUtf8, sizeof(nameUtf8), nullptr, nullptr);
        }

        DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY tech = paths[i].targetInfo.outputTechnology;
        bool isVirtualByTech = (tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INDIRECT_WIRED)
                            || (tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INDIRECT_VIRTUAL);
        bool isVirtualByName = gotName && (
            wcsstr(targetName.monitorFriendlyDeviceName, L"AegisDisplay") != nullptr ||
            wcsstr(targetName.monitorFriendlyDeviceName, L"MTT")          != nullptr ||
            wcsstr(targetName.monitorFriendlyDeviceName, L"VDD")          != nullptr ||
            wcsstr(targetName.monitorFriendlyDeviceName, L"Virtual")      != nullptr
        );
        bool isVirtual = isVirtualByTech || isVirtualByName;
        bool isInternal = (tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL)
                       || (tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED);

        char logLine[256];
        sprintf_s(logLine, sizeof(logLine), "  path[%u] tech=%s name=\"%s\" virtual=%s internal=%s",
                  i, outputTechName(tech), nameUtf8, isVirtual ? "Y" : "N", isInternal ? "Y" : "N");
        logReassign(logLine);

        if (isVirtual) {
            if (virtualPathIdx == -1) virtualPathIdx = (int)i;
            continue;
        }
        // Prefer INTERNAL over other non-virtual (HDMI/DP external) — Surface laptop = INTERNAL
        if (isInternal) {
            realPathIdx = (int)i;
        } else if (realPathIdx == -1) {
            realPathIdx = (int)i;  // first non-virtual non-internal as fallback
        }
    }

    if (realPathIdx < 0) {
        logReassign("ERR no real (non-virtual) display found");
        return false;
    }

    // Locate the source modes for real + virtual paths
    int realSrcModeIdx = -1, virtualSrcModeIdx = -1;
    for (UINT32 j = 0; j < modeCount; ++j) {
        if (modes[j].infoType != DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE) continue;
        if (modes[j].adapterId.LowPart  == paths[realPathIdx].sourceInfo.adapterId.LowPart &&
            modes[j].adapterId.HighPart == paths[realPathIdx].sourceInfo.adapterId.HighPart &&
            modes[j].id == paths[realPathIdx].sourceInfo.id) {
            realSrcModeIdx = (int)j;
        }
        if (virtualPathIdx >= 0 &&
            modes[j].adapterId.LowPart  == paths[virtualPathIdx].sourceInfo.adapterId.LowPart &&
            modes[j].adapterId.HighPart == paths[virtualPathIdx].sourceInfo.adapterId.HighPart &&
            modes[j].id == paths[virtualPathIdx].sourceInfo.id) {
            virtualSrcModeIdx = (int)j;
        }
    }
    if (realSrcModeIdx < 0) {
        logReassign("ERR no matching source mode for real path");
        return false;
    }

    {
        char dump[256];
        sprintf_s(dump, sizeof(dump), "  real source[%d] BEFORE pos=(%d,%d) size=%ux%u",
                  realSrcModeIdx,
                  modes[realSrcModeIdx].sourceMode.position.x,
                  modes[realSrcModeIdx].sourceMode.position.y,
                  modes[realSrcModeIdx].sourceMode.width,
                  modes[realSrcModeIdx].sourceMode.height);
        logReassign(dump);
        if (virtualSrcModeIdx >= 0) {
            sprintf_s(dump, sizeof(dump), "  virtual source[%d] BEFORE pos=(%d,%d) size=%ux%u",
                      virtualSrcModeIdx,
                      modes[virtualSrcModeIdx].sourceMode.position.x,
                      modes[virtualSrcModeIdx].sourceMode.position.y,
                      modes[virtualSrcModeIdx].sourceMode.width,
                      modes[virtualSrcModeIdx].sourceMode.height);
            logReassign(dump);
        }
    }

    // Compute desired layout: real at (0,0); virtual at (real.width, 0).
    LONG desiredRealX = 0, desiredRealY = 0;
    LONG desiredVirtualX = (LONG)modes[realSrcModeIdx].sourceMode.width;
    if (desiredVirtualX <= 0) desiredVirtualX = 1920;
    LONG desiredVirtualY = 0;

    bool realAlreadyOK = (modes[realSrcModeIdx].sourceMode.position.x == desiredRealX
                          && modes[realSrcModeIdx].sourceMode.position.y == desiredRealY);
    bool virtualAlreadyOK = (virtualSrcModeIdx < 0) ||
                            (modes[virtualSrcModeIdx].sourceMode.position.x == desiredVirtualX
                             && modes[virtualSrcModeIdx].sourceMode.position.y == desiredVirtualY);
    if (realAlreadyOK && virtualAlreadyOK) {
        logReassign("  no change needed (layout already correct) — skip SetDisplayConfig");
        return true;
    }

    // Translate QueryDisplayConfig source IDs to GDI device names (\\.\DISPLAYn)
    // so we can use ChangeDisplaySettingsExW — SetDisplayConfig returns rc=87
    // (ERROR_INVALID_PARAMETER) when only repositioning sources, even when the
    // path/mode structures look correct. The CDS path is simpler and reliable
    // for "make X primary + reposition Y".
    DISPLAYCONFIG_SOURCE_DEVICE_NAME realSrcName{};
    realSrcName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
    realSrcName.header.size = sizeof(realSrcName);
    realSrcName.header.adapterId = paths[realPathIdx].sourceInfo.adapterId;
    realSrcName.header.id = paths[realPathIdx].sourceInfo.id;
    if (DisplayConfigGetDeviceInfo(&realSrcName.header) != ERROR_SUCCESS) {
        logReassign("ERR DisplayConfigGetDeviceInfo(real source) failed");
        return false;
    }

    DEVMODEW dmReal{};
    dmReal.dmSize = sizeof(dmReal);
    if (!EnumDisplaySettingsExW(realSrcName.viewGdiDeviceName, ENUM_CURRENT_SETTINGS, &dmReal, 0)) {
        logReassign("ERR EnumDisplaySettingsExW(real) failed");
        return false;
    }
    dmReal.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT;
    dmReal.dmPosition.x = desiredRealX;
    dmReal.dmPosition.y = desiredRealY;
    LONG rcReal = ChangeDisplaySettingsExW(realSrcName.viewGdiDeviceName, &dmReal, nullptr,
                                            CDS_SET_PRIMARY | CDS_UPDATEREGISTRY | CDS_NORESET, nullptr);
    char rcLine[200];
    sprintf_s(rcLine, sizeof(rcLine), "  CDS(real, %ls, SET_PRIMARY pos=(%ld,%ld)) rc=%ld",
              realSrcName.viewGdiDeviceName, desiredRealX, desiredRealY, rcReal);
    logReassign(rcLine);

    LONG rcVirt = DISP_CHANGE_SUCCESSFUL;
    if (virtualSrcModeIdx >= 0 && virtualPathIdx >= 0) {
        DISPLAYCONFIG_SOURCE_DEVICE_NAME vSrcName{};
        vSrcName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        vSrcName.header.size = sizeof(vSrcName);
        vSrcName.header.adapterId = paths[virtualPathIdx].sourceInfo.adapterId;
        vSrcName.header.id = paths[virtualPathIdx].sourceInfo.id;
        if (DisplayConfigGetDeviceInfo(&vSrcName.header) == ERROR_SUCCESS) {
            DEVMODEW dmVirt{};
            dmVirt.dmSize = sizeof(dmVirt);
            if (EnumDisplaySettingsExW(vSrcName.viewGdiDeviceName, ENUM_CURRENT_SETTINGS, &dmVirt, 0)) {
                dmVirt.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT;
                dmVirt.dmPosition.x = desiredVirtualX;
                dmVirt.dmPosition.y = desiredVirtualY;
                rcVirt = ChangeDisplaySettingsExW(vSrcName.viewGdiDeviceName, &dmVirt, nullptr,
                                                   CDS_UPDATEREGISTRY | CDS_NORESET, nullptr);
                sprintf_s(rcLine, sizeof(rcLine), "  CDS(virtual, %ls, pos=(%ld,%ld)) rc=%ld",
                          vSrcName.viewGdiDeviceName, desiredVirtualX, desiredVirtualY, rcVirt);
                logReassign(rcLine);
            }
        } else {
            logReassign("  WARN DisplayConfigGetDeviceInfo(virtual source) failed — skip virt reposition");
        }
    }

    LONG rcCommit = ChangeDisplaySettingsExW(nullptr, nullptr, nullptr, 0, nullptr);
    sprintf_s(rcLine, sizeof(rcLine), "CDS commit rc=%ld %s",
              rcCommit, rcCommit == DISP_CHANGE_SUCCESSFUL ? "OK" : "FAILED");
    logReassign(rcLine);
    return rcCommit == DISP_CHANGE_SUCCESSFUL && rcReal == DISP_CHANGE_SUCCESSFUL;
}

VirtualDisplayStatus queryStatus() {
    VirtualDisplayStatus s;
    if (!isInstalled()) {
        s.supported = false;
        s.enabled = false;
        s.reason = "AegisDisplay driver not installed";
        return s;
    }
    s.supported = true;
    std::string xml = readSettingsFile();
    if (xml.empty()) {
        // Settings file absent but driver installed — treat as disabled.
        s.enabled = false;
        return s;
    }
    int count = readMonitorCount(xml);
    s.enabled = (count > 0);
    if (s.enabled) {
        s.resolution = readFirstResolution(xml);
    }
    return s;
}

bool enable(const std::string& resolution, VirtualDisplayStatus& out) {
    if (!isInstalled()) {
        out.supported = false;
        out.enabled = false;
        out.reason = "AegisDisplay driver not installed";
        return false;
    }
    int w = 0, h = 0;
    parseResolution(resolution, w, h);
    std::string xml = readSettingsFile();
    if (xml.empty()) {
        xml = kDefaultSettingsXml;
    }
    if (!replaceMonitorCount(xml, 1)) {
        out.supported = true;
        out.enabled = false;
        out.reason = "vdd_settings.xml missing <monitors><count> element";
        return false;
    }
    if (!replaceResolutionList(xml, w, h)) {
        out.supported = true;
        out.enabled = false;
        out.reason = "vdd_settings.xml missing <resolutions> block";
        return false;
    }
    if (!writeSettingsFile(xml)) {
        out.supported = true;
        out.enabled = false;
        out.reason = "failed to write C:\\AegisDisplay\\vdd_settings.xml (admin?)";
        return false;
    }
    sendReload();  // best-effort; xml edit alone covers cold-start case

    // After the new virtual monitor enumerates, Windows often promotes it to
    // PRIMARY (especially when it's higher resolution than the laptop panel —
    // 2560x1440 vs Surface's native). That breaks the extend UX: user's real
    // screen suddenly shows the secondary portion of the extended desktop.
    // Sleep briefly to let Windows finish enumerating the new monitor, then
    // force the real display back to primary (same SetDisplayConfig path used
    // by disable()).
    Sleep(800);
    reassignPrimaryToRealDisplay();

    out.supported = true;
    out.enabled = true;
    return true;
}

VirtualDisplayStatus disable() {
    VirtualDisplayStatus s;
    if (!isInstalled()) {
        s.supported = false;
        s.enabled = false;
        s.reason = "AegisDisplay driver not installed";
        return s;
    }
    s.supported = true;
    std::string xml = readSettingsFile();
    if (xml.empty()) {
        // No xml yet → ensure one exists with count=0 so driver loads disabled.
        // Without this, driver uses its built-in default (count=1, the upstream
        // "5 virtual monitors" semantics) and a phantom monitor sticks around
        // even when user hasn't clicked 延伸.
        xml = kDefaultSettingsXml;
    }
    if (replaceMonitorCount(xml, 0)) {
        writeSettingsFile(xml);
        sendReload();
    }
    // Upstream driver's InitAdapter doesn't detach the monitor when count drops
    // to 0, so AegisDisplay can linger in the display layout — and Windows may
    // have promoted it to PRIMARY. Force the real (non-AegisDisplay) display
    // back to primary (0,0). User-mode SetDisplayConfig — no admin needed.
    reassignPrimaryToRealDisplay();
    s.enabled = false;
    return s;
}

}  // namespace driver

// --- Arg parsing -------------------------------------------------------------
// argv[1] = subcommand; remaining args are --key value pairs.
std::unordered_map<std::string, std::string> parseFlags(int argc, char** argv, int start) {
    std::unordered_map<std::string, std::string> flags;
    for (int i = start; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg.rfind("--", 0) == 0 && i + 1 < argc) {
            flags[arg.substr(2)] = argv[i + 1];
            ++i;
        }
    }
    return flags;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        emitError("usage: AegisDisplayControl <status|enable|disable> [--resolution WxH]");
        return 2;
    }

    const std::string subcommand = argv[1];
    const auto flags = parseFlags(argc, argv, 2);

    if (subcommand == "status") {
        emitJSON(driver::queryStatus());
        return 0;
    }

    if (subcommand == "enable") {
        auto it = flags.find("resolution");
        if (it == flags.end() || !isValidResolution(it->second)) {
            emitError("--resolution required (1920x1080|2560x1440|3840x2160)");
            return 2;
        }
        VirtualDisplayStatus status;
        if (!driver::enable(it->second, status)) {
            emitJSON(status);  // carries .reason explaining the failure
            return 1;
        }
        status.resolution = it->second;
        emitJSON(status);
        return 0;
    }

    if (subcommand == "disable") {
        emitJSON(driver::disable());
        return 0;
    }

    emitError("unknown subcommand '" + subcommand + "' (expected status|enable|disable)");
    return 2;
}
