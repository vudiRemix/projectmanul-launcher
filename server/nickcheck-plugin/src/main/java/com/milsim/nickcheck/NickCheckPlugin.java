package com.milsim.nickcheck;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.logging.Level;
import java.util.regex.Pattern;

/**
 * Отвечает лаунчеру, зарегистрирован ли ник в AuthMe.
 * GET /nick/{ник} -> {"nick":"...","registered":true|false}
 * Наружу не отдаёт ничего, кроме да/нет; запросы ограничены по частоте на IP.
 * AuthMe вызывается через его публичный API (рефлексией), доступ к MySQL не нужен.
 */
public final class NickCheckPlugin extends JavaPlugin {
    private static final Pattern NICK = Pattern.compile("^[A-Za-z0-9_]{3,16}$");

    private HttpServer server;
    private ExecutorService executor;
    private Object authMeApi;
    private Method isRegistered;
    private int limitPerMinute;
    private final Map<String, Deque<Long>> hits = new ConcurrentHashMap<>();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        String bind = getConfig().getString("bind", "0.0.0.0");
        int port = getConfig().getInt("port", 8765);
        limitPerMinute = Math.max(1, getConfig().getInt("requests-per-minute", 30));

        if (!hookAuthMe()) {
            getLogger().severe("AuthMe не найден или его API недоступен — проверка ника выключена.");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        try {
            server = HttpServer.create(new InetSocketAddress(bind, port), 32);
        } catch (IOException e) {
            getLogger().log(Level.SEVERE, "Не удалось открыть порт " + port + " для проверки ника", e);
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        executor = Executors.newFixedThreadPool(2, r -> {
            Thread t = new Thread(r, "NickCheck-HTTP");
            t.setDaemon(true);
            return t;
        });
        server.setExecutor(executor);
        server.createContext("/nick/", this::handle);
        server.start();
        getLogger().info("Проверка ника слушает http://" + bind + ":" + port + "/nick/{ник}");
    }

    @Override
    public void onDisable() {
        if (server != null) server.stop(0);
        if (executor != null) executor.shutdownNow();
    }

    private boolean hookAuthMe() {
        Plugin authMe = getServer().getPluginManager().getPlugin("AuthMe");
        if (authMe == null || !authMe.isEnabled()) return false;
        try {
            Class<?> apiClass = Class.forName("fr.xephi.authme.api.v3.AuthMeApi", true, authMe.getClass().getClassLoader());
            authMeApi = apiClass.getMethod("getInstance").invoke(null);
            isRegistered = apiClass.getMethod("isRegistered", String.class);
            return authMeApi != null;
        } catch (ReflectiveOperationException e) {
            getLogger().log(Level.SEVERE, "Не удалось подключиться к API AuthMe", e);
            return false;
        }
    }

    private void handle(HttpExchange ex) throws IOException {
        try {
            if (!"GET".equals(ex.getRequestMethod())) {
                send(ex, 405, "{\"error\":\"method\"}");
                return;
            }
            String ip = ex.getRemoteAddress().getAddress().getHostAddress();
            if (!allow(ip)) {
                send(ex, 429, "{\"error\":\"rate-limit\"}");
                return;
            }
            String path = ex.getRequestURI().getPath();
            String nick = path.substring("/nick/".length());
            if (!NICK.matcher(nick).matches()) {
                send(ex, 400, "{\"error\":\"nick\"}");
                return;
            }
            boolean registered = (Boolean) isRegistered.invoke(authMeApi, nick);
            send(ex, 200, "{\"nick\":\"" + nick + "\",\"registered\":" + registered + "}");
        } catch (Exception e) {
            getLogger().log(Level.WARNING, "Ошибка проверки ника", e);
            send(ex, 500, "{\"error\":\"internal\"}");
        } finally {
            ex.close();
        }
    }

    // Скользящее окно в 60 секунд на каждый IP.
    private boolean allow(String ip) {
        long now = System.currentTimeMillis();
        Deque<Long> q = hits.computeIfAbsent(ip, k -> new ArrayDeque<>());
        synchronized (q) {
            while (!q.isEmpty() && now - q.peekFirst() > 60_000) q.pollFirst();
            if (q.size() >= limitPerMinute) return false;
            q.addLast(now);
        }
        if (hits.size() > 10_000) hits.entrySet().removeIf(e -> e.getValue().isEmpty());
        return true;
    }

    private static void send(HttpExchange ex, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(body);
        }
    }
}
