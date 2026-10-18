package com.aegisrd.aegistrans;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;

/**
 * AegisFileStream — >2GB stream-to-disk 原生層（Android，與 Electron main 的 fstream 同構）。
 *
 * 收檔：renderer 每收一個解密 chunk 就 write(fileId, offset, base64) → RandomAccessFile
 * seek+write random-access 落盤（chunk 亂序到達天然安全）。finalize 驗 size + 串流 SHA-256，
 * 過了才 rename 到 filesDir/aegistrans-files/<fileId>-<name>。
 *
 * 記憶體紀律（HANDOFF 使用者交代）：任何方法只碰單一 chunk，native 端絕不 accumulate；
 * SHA-256 用 1MB buffer 串流讀檔算，不載整檔。
 *
 * 所有預期錯誤 resolve {ok:false, error}（對齊 Electron 介面）；reject 只留給參數缺失。
 * 所有方法 synchronized：Capacitor 可能並發呼叫，seek+write 必須原子；64KB 磁碟寫入很快，
 * 全域序列化即可（Electron main 也是 per-file promise chain 序列化）。
 */
@CapacitorPlugin(name = "AegisFileStream")
public class AegisFileStreamPlugin extends Plugin {

    private final Map<String, RandomAccessFile> handles = new HashMap<>();

    private File dir() {
        return new File(getContext().getFilesDir(), "aegistrans-files");
    }

    private File tmpFile(String fileId) {
        return new File(dir(), ".tmp-" + fileId);
    }

    /** fileId 是我們自己生的 UUID，防禦性擋路徑穿越。 */
    private static boolean badId(String fileId) {
        return fileId == null || fileId.isEmpty() || fileId.contains("/") || fileId.contains("\\") || fileId.contains("..");
    }

    /** path 必須落在 aegistrans-files/ 內（read/stat/delete 只服務自家收的檔）。 */
    private boolean insideDir(String path) {
        try {
            return new File(path).getCanonicalPath().startsWith(dir().getCanonicalPath() + File.separator);
        } catch (Exception e) {
            return false;
        }
    }

    /** 取整數參數（offset/size 會 >2^31）。org.json 把大整數存成 Long、小的存 Integer，
     *  Capacitor 的 getDouble 對 Long 回 null → 2GiB 以上的 offset 全滅（2026-07-19 Z Fold
     *  2.2GB e2e 抓到：暫存檔正好停在 2^31-65536）。一律用 Number 韌性取值。 */
    private static long getLong(PluginCall call, String key) {
        Object v = call.getData().opt(key);
        return v instanceof Number ? ((Number) v).longValue() : -1L;
    }

    private static JSObject okResult() {
        return new JSObject().put("ok", true);
    }

    private static JSObject errResult(String error) {
        return new JSObject().put("ok", false).put("error", error);
    }

    @PluginMethod
    public synchronized void open(PluginCall call) {
        String fileId = call.getString("fileId");
        if (badId(fileId)) { call.reject("fileId required"); return; }
        try {
            RandomAccessFile prev = handles.remove(fileId);
            if (prev != null) prev.close();
            File d = dir();
            if (!d.exists() && !d.mkdirs()) { call.resolve(errResult("mkdir failed")); return; }
            File tmp = tmpFile(fileId);
            if (tmp.exists() && !tmp.delete()) { call.resolve(errResult("stale tmp delete failed")); return; }
            handles.put(fileId, new RandomAccessFile(tmp, "rw"));
            call.resolve(okResult());
        } catch (Exception e) {
            call.resolve(errResult("open: " + e.getMessage()));
        }
    }

    @PluginMethod
    public synchronized void write(PluginCall call) {
        String fileId = call.getString("fileId");
        String data = call.getString("data");
        long offset = getLong(call, "offset");
        if (badId(fileId) || data == null || offset < 0) { call.reject("fileId/offset/data required"); return; }
        RandomAccessFile raf = handles.get(fileId);
        if (raf == null) { call.resolve(errResult("not open")); return; }
        try {
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            raf.seek(offset);
            raf.write(bytes);
            call.resolve(okResult());
        } catch (Exception e) {
            call.resolve(errResult("write: " + e.getMessage()));
        }
    }

    @PluginMethod
    public synchronized void finalize(PluginCall call) {
        String fileId = call.getString("fileId");
        String sha256 = call.getString("sha256");
        String name = call.getString("name");
        long size = getLong(call, "size");
        if (badId(fileId) || sha256 == null || name == null || size < 0) {
            call.reject("fileId/sha256/size/name required");
            return;
        }
        File tmp = tmpFile(fileId);
        try {
            RandomAccessFile raf = handles.remove(fileId);
            if (raf != null) raf.close();
            if (!tmp.exists()) { call.resolve(errResult("tmp missing")); return; }
            long actual = tmp.length();
            if (actual != size) {
                tmp.delete();
                call.resolve(errResult("size mismatch: " + actual + " != " + size));
                return;
            }
            String actualSha = sha256Hex(tmp);
            if (!actualSha.equalsIgnoreCase(sha256)) {
                tmp.delete();
                call.resolve(errResult("sha256 mismatch"));
                return;
            }
            // 檔名去掉路徑分隔符（來自遠端 manifest，不可信任）；fileId 前綴保證不撞名
            String safeName = name.replaceAll("[/\\\\]", "_");
            File dest = new File(dir(), fileId + "-" + safeName);
            if (dest.exists() && !dest.delete()) { call.resolve(errResult("dest exists")); return; }
            if (!tmp.renameTo(dest)) { call.resolve(errResult("rename failed")); return; }
            call.resolve(okResult().put("path", dest.getAbsolutePath()));
        } catch (Exception e) {
            tmp.delete();
            call.resolve(errResult("finalize: " + e.getMessage()));
        }
    }

    @PluginMethod
    public synchronized void abort(PluginCall call) {
        String fileId = call.getString("fileId");
        if (badId(fileId)) { call.reject("fileId required"); return; }
        try {
            RandomAccessFile raf = handles.remove(fileId);
            if (raf != null) raf.close();
        } catch (Exception ignored) { /* 盡力關；tmp 刪除照做 */ }
        tmpFile(fileId).delete();
        call.resolve(okResult());
    }

    @PluginMethod
    public synchronized void read(PluginCall call) {
        String path = call.getString("path");
        long offset = getLong(call, "offset");
        Integer length = call.getInt("length");
        if (path == null || offset < 0 || length == null) { call.reject("path/offset/length required"); return; }
        if (!insideDir(path)) { call.reject("path outside managed dir"); return; }
        try (RandomAccessFile raf = new RandomAccessFile(path, "r")) {
            raf.seek(offset);
            byte[] buf = new byte[length];
            int total = 0;
            while (total < length) {
                int n = raf.read(buf, total, length - total);
                if (n < 0) break; // EOF：回實際讀到的（對齊 Node fs.read 語意）
                total += n;
            }
            byte[] out = total == length ? buf : java.util.Arrays.copyOf(buf, total);
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(out, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("read: " + e.getMessage());
        }
    }

    @PluginMethod
    public synchronized void stat(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("path required"); return; }
        File f = new File(path);
        boolean exists = insideDir(path) && f.isFile();
        JSObject ret = new JSObject();
        ret.put("exists", exists);
        ret.put("size", exists ? f.length() : 0);
        call.resolve(ret);
    }

    @PluginMethod
    public synchronized void delete(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("path required"); return; }
        if (!insideDir(path)) { call.resolve(errResult("path outside managed dir")); return; }
        File f = new File(path);
        if (f.exists() && !f.delete()) { call.resolve(errResult("delete failed")); return; }
        call.resolve(okResult());
    }

    @PluginMethod
    public synchronized void wipeAll(PluginCall call) {
        for (RandomAccessFile raf : handles.values()) {
            try { raf.close(); } catch (Exception ignored) { }
        }
        handles.clear();
        File d = dir();
        File[] files = d.listFiles();
        StringBuilder failed = new StringBuilder();
        if (files != null) {
            for (File f : files) {
                if (!f.delete()) failed.append(f.getName()).append(' ');
            }
        }
        if (failed.length() > 0) call.resolve(errResult("wipe incomplete: " + failed));
        else call.resolve(okResult());
    }

    @PluginMethod
    public synchronized void freeBytes(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("free", getContext().getFilesDir().getUsableSpace());
        call.resolve(ret);
    }

    /** 串流 SHA-256（1MB buffer，不載整檔進 RAM）。 */
    private static String sha256Hex(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[1024 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
