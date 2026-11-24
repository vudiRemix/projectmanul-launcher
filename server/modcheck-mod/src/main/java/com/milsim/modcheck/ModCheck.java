package com.milsim.modcheck;

import com.mojang.logging.LogUtils;
import net.minecraft.network.Connection;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.ForgeConfigSpec;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.fml.IExtensionPoint;
import net.minecraftforge.fml.ModList;
import net.minecraftforge.fml.ModLoadingContext;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.config.ModConfig;
import net.minecraftforge.network.ConnectionData;
import net.minecraftforge.network.NetworkHooks;
import net.minecraftforge.forgespi.language.IModInfo;
import org.slf4j.Logger;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Серверный мод: при входе сверяет список модов клиента (из рукопожатия Forge)
 * с модами сервера и белым списком клиентских модов. Лишние — кик с их списком.
 * Клиентам этот мод ставить не нужно.
 */
@Mod(ModCheck.MODID)
public final class ModCheck {
    public static final String MODID = "modcheck";
    private static final Logger LOG = LogUtils.getLogger();

    private static final ForgeConfigSpec SPEC;
    private static final ForgeConfigSpec.BooleanValue ENABLED;
    private static final ForgeConfigSpec.BooleanValue KICK_VANILLA;
    private static final ForgeConfigSpec.ConfigValue<List<? extends String>> ALLOWED_CLIENT_MODS;
    private static final ForgeConfigSpec.ConfigValue<String> KICK_MESSAGE;
    private static final ForgeConfigSpec.ConfigValue<String> KICK_VANILLA_MESSAGE;

    static {
        ForgeConfigSpec.Builder b = new ForgeConfigSpec.Builder();
        ENABLED = b.comment("Включить проверку модов клиента").define("enabled", true);
        KICK_VANILLA = b.comment("Кикать клиентов без Forge-рукопожатия (ванильный клиент)").define("kickVanilla", true);
        ALLOWED_CLIENT_MODS = b.comment(
                "Клиентские моды из сборки, которых нет на сервере (миникарта, шейдеры и т.п.).",
                "Моды сервера разрешены автоматически. Пример: [\"oculus\", \"embeddium\"]")
                .defineListAllowEmpty(List.of("allowedClientMods"), List::of, o -> o instanceof String);
        KICK_MESSAGE = b.comment("Текст кика, {mods} — список лишних модов")
                .define("kickMessage", "Лишние моды: {mods}. Запустите игру через лаунчер проекта и нажмите «Проверить файлы».");
        KICK_VANILLA_MESSAGE = b.define("kickVanillaMessage", "Зайдите на сервер через лаунчер проекта.");
        SPEC = b.build();
    }

    public ModCheck() {
        ModLoadingContext.get().registerConfig(ModConfig.Type.COMMON, SPEC, "modcheck-server.toml");
        // Мод только серверный: клиент без него не считается несовместимым.
        ModLoadingContext.get().registerExtensionPoint(IExtensionPoint.DisplayTest.class,
                () -> new IExtensionPoint.DisplayTest(() -> IExtensionPoint.DisplayTest.IGNORESERVERONLY, (remote, isServer) -> true));
        MinecraftForge.EVENT_BUS.addListener(this::onLogin);
    }

    private void onLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!ENABLED.get() || !(event.getEntity() instanceof ServerPlayer player)) return;
        Connection connection = player.connection.connection;
        if (connection.isMemoryConnection()) return; // одиночная игра / встроенный сервер
        String name = player.getGameProfile().getName();

        ConnectionData data = NetworkHooks.getConnectionData(connection);
        if (data == null) {
            if (KICK_VANILLA.get()) {
                LOG.warn("[ModCheck] {} без Forge-рукопожатия — кик", name);
                player.connection.disconnect(Component.literal(KICK_VANILLA_MESSAGE.get()));
            }
            return;
        }

        Set<String> allowed = new HashSet<>();
        for (IModInfo mod : ModList.get().getMods()) allowed.add(mod.getModId().toLowerCase(Locale.ROOT));
        for (String id : ALLOWED_CLIENT_MODS.get()) allowed.add(id.toLowerCase(Locale.ROOT));

        List<String> extra = data.getModList().stream()
                .filter(id -> !allowed.contains(id.toLowerCase(Locale.ROOT)))
                .sorted()
                .toList();
        if (extra.isEmpty()) return;

        String list = String.join(", ", extra);
        LOG.warn("[ModCheck] {} кикнут, лишние моды: {}", name, list);
        player.connection.disconnect(Component.literal(KICK_MESSAGE.get().replace("{mods}", list)));
    }
}
