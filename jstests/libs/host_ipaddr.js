// Returns non-localhost ipaddr of host running the mongo shell process
function get_ipaddr() {
    // set temp path, if it exists
    var path = "";
    try {
        path = TestData.tmpPath;
        if (typeof path == "undefined") {
            path = "";
        } else if (path.slice(-1) != "/") {
            // Terminate path with / if defined
            path += "/";
        }
    } catch (err) {
    }

    var ipFile = path + "ipaddr-" + Random.srand() + ".log";
    var windowsCmd = "ipconfig > " + ipFile;
    // Prefer `ip` if available; fall back to ifconfig. Both may be absent in minimal containers.
    var unixCmds = [
        "ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 > " + ipFile,
        "ip -o -4 addr 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v '^127\\.' > " +
            ipFile,
        "/sbin/ifconfig 2>/dev/null | grep inet | grep -v '127.0.0.1' > " + ipFile,
        "ifconfig 2>/dev/null | grep inet | grep -v '127.0.0.1' > " + ipFile,
        "hostname -I 2>/dev/null | tr ' ' '\\n' | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' | grep -v '^127\\.' > " +
            ipFile,
    ];
    var ipAddr = null;
    var hostType = null;

    try {
        hostType = getBuildInfo().buildEnvironment.target_os;

        // os-specific methods
        if (hostType == "windows") {
            runProgram('cmd.exe', '/c', windowsCmd);
            ipAddr = cat(ipFile).match(/IPv4.*: (.*)/)[1];
        } else {
            for (var i = 0; i < unixCmds.length; i++) {
                runProgram('bash', '-c', unixCmds[i]);
                var content = cat(ipFile).replace(/addr:/g, "").trim();
                if (!content) {
                    continue;
                }
                // Try to find an IPv4 address on the first line.
                var m = content.match(/([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)/);
                if (m) {
                    ipAddr = m[1];
                    break;
                }
            }
        }
    } finally {
        removeFile(ipFile);
    }
    return ipAddr;
}

function get_ipaddr6() {
    // set temp path, if it exists
    var path = "";
    try {
        path = TestData.tmpPath;
        if (typeof path == "undefined") {
            path = "";
        } else if (path.slice(-1) != "/") {
            // Terminate path with / if defined
            path += "/";
        }
    } catch (err) {
    }

    var ipFile = path + "ipaddr.log";
    var windowsCmd = "ipconfig > " + ipFile;
    var unixCmd = "/sbin/ifconfig | grep inet | grep -v '127.0.0.1' > " + ipFile;
    var ipAddr = null;
    var hostType = null;

    try {
        hostType = getBuildInfo().buildEnvironment.target_os;

        // os-specific methods
        if (hostType == "windows") {
            runProgram('cmd.exe', '/c', windowsCmd);
            ipAddr = cat(ipFile).match(/IPv6.*: (.*)/)[1];
        } else {
            runProgram('bash', '-c', unixCmd);
            ipAddr = cat(ipFile).replace(/addr:/g, "").match(/inet6 (.[^ ]*) /)[1];
        }
    } finally {
        removeFile(ipFile);
    }
    return ipAddr;
}