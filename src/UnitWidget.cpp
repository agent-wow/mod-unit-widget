// SPDX-License-Identifier: GPL-2.0-or-later
#include "UnitWidgetSender.h"
#include "AllSpellScript.h"
#include "Config.h"
#include "WidgetWatch.h"
#include "Creature.h"
#include "CryptoRandom.h"
#include "Log.h"
#include "Player.h"
#include "PlayerScript.h"
#include "Spell.h"
#include "SpellAuras.h"
#include "SpellInfo.h"
#include "StringFormat.h"
#include "WorldScript.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"
#include <boost/uuid/uuid.hpp>
#include <boost/uuid/uuid_io.hpp>
#include <algorithm>
#include <stdexcept>

namespace UnitWidget
{
namespace
{
enum class SpellEventType
{
    Prepare,
    Cast,
    Cancel
};

Time Now() { return std::chrono::steady_clock::now(); }

std::string ProcessId()
{
    auto bytes = Acore::Crypto::GetRandomBytes<16>();
    boost::uuids::uuid id;
    std::copy(bytes.begin(), bytes.end(), id.begin());
    return boost::uuids::to_string(id);
}

std::string CastKey(Unit* unit, bool channel)
{
    return unit->GetGUID().ToString() + (channel ? "/channel" : "/cast");
}

std::string SpellName(SpellInfo const* info)
{
    return info->SpellName[0] && *info->SpellName[0] ? info->SpellName[0] : "Unknown spell";
}

Json Power(Unit* unit, Powers type)
{
    if (type < POWER_MANA || type >= MAX_POWERS || type == POWER_RUNE)
        return nullptr;
    auto maximum = unit->GetMaxPower(type);
    if (!maximum)
        return nullptr;
    return {{"type", type}, {"value", DisplayPower(type, unit->GetPower(type))},
        {"max", DisplayPower(type, maximum)}};
}

class Service
{
public:
    void Start()
    {
        if (_sender || !sConfigMgr->GetOption<bool>("UnitWidget.Enable", true))
            return;
        auto endpoint = sConfigMgr->GetOption<std::string>("UnitWidget.Endpoint", "");
        if (endpoint.empty())
            return;
        try
        {
            auto source = sConfigMgr->GetOption<std::string>("UnitWidget.SourceId",
                Acore::StringFormat("realm-{}", sConfigMgr->GetOption<uint32>("RealmID", 1)));
            _interval = sConfigMgr->GetOption<uint32>("UnitWidget.UpdateIntervalMs", 100);
            auto queueBytes = sConfigMgr->GetOption<uint32>("UnitWidget.QueueBytes", 16 * 1024 * 1024);
            if (source.empty() || source.size() > 256 || _interval < 50 || _interval > 1000 ||
                queueBytes < 512 * 1024 || queueBytes > 256 * 1024 * 1024)
                throw std::invalid_argument("invalid unit widget limits");
            static_cast<void>(Json(source).dump());
            HttpOptions http;
            http.Destination = ParseEndpoint(endpoint);
            http.BearerToken = sConfigMgr->GetOption<std::string>("UnitWidget.BearerToken", "");
            http.CaFile = sConfigMgr->GetOption<std::string>("UnitWidget.CAFile", "");
            http.ConnectTimeout = Milliseconds(sConfigMgr->GetOption<uint32>("UnitWidget.ConnectTimeoutMs", 750));
            http.RequestTimeout = Milliseconds(sConfigMgr->GetOption<uint32>("UnitWidget.RequestTimeoutMs", 1500));
            if (http.RequestTimeout > Milliseconds(3000))
                throw std::invalid_argument("request timeout exceeds freshness budget");
            _sender = std::make_unique<Sender>(std::move(http), source, ProcessId(), queueBytes);
            _enabled.store(true);
            LOG_INFO("module.unitwidget", "Unit widget enabled; sample interval {}ms", _interval);
        }
        catch (std::exception const&)
        {
            LOG_ERROR("module.unitwidget", "Invalid unit widget configuration; capture disabled");
        }
    }

    void Stop()
    {
        _enabled.store(false);
        _sender.reset();
    }

    void Update(uint32 diff)
    {
        if (!_sender)
            return;
        _elapsed += diff;
        if (_elapsed < _interval)
            return;
        _elapsed %= _interval;
        auto now = Now();
        _casts.Prune(now);
        // World::Update invokes this hook after MapMgr::Update joins its map workers.
        for (auto const& [account, session] : sWorldSessionMgr->GetAllSessions())
        {
            static_cast<void>(account);
            if (Player* player = session->GetPlayer())
                if (!session->PlayerLogout())
                    Capture(player, player->IsInWorld() && !player->IsBeingTeleported() ? "online" : "unavailable");
        }
    }

    void Capture(Player* player, char const* presence)
    {
        if (!_sender)
            return;
        try
        {
            auto now = Now();
            bool available = std::string_view(presence) == "online";
            Json self = available ? Frame(player, player, true, now) : Json(nullptr);
            Json target = nullptr;
            if (available)
                if (Unit* selected = player->GetSelectedUnit())
                    if (selected->IsInWorld() && (selected == player || player->HaveAtClient(selected)))
                        target = Frame(selected, player, false, now);
            auto guid = player->GetGUID().ToString();
            _sender->Push({guid, ++_sequence, now, {{"guid", guid}, {"name", player->GetName()},
                {"presence", presence}, {"watch_target", WidgetWatch::Capture<Json>(player,
                    std::string_view(presence) == "offline")},
                {"player", std::move(self)}, {"target", std::move(target)}}});
        }
        catch (std::exception const&)
        {
            if (Now() >= _nextError)
            {
                LOG_WARN("module.unitwidget", "Unable to capture a unit widget snapshot");
                _nextError = Now() + std::chrono::seconds(30);
            }
        }
    }

    void SpellEvent(Spell* spell, Unit* caster, SpellInfo const* info, SpellEventType event,
        bool bySelf = false)
    {
        if (!_enabled.load() || !caster || !spell->IsNeedSendToClient(false))
            return;
        bool channel = info->IsChanneled();
        auto key = CastKey(caster, channel);
        auto now = Now();
        if (event == SpellEventType::Prepare && !channel && spell->getState() == SPELL_STATE_PREPARING &&
            spell->GetCastTime() > 0)
            _casts.Start(key, info->Id, SpellName(info), false, spell->GetCastTime(), now);
        else if (event == SpellEventType::Cast && channel && spell->getState() == SPELL_STATE_CASTING &&
            !info->HasAttribute(SPELL_ATTR3_HIDE_CHANNEL_BAR))
            _casts.Start(key, info->Id, SpellName(info), true, spell->GetCastTimeRemaining(), now);
        else if (event == SpellEventType::Cast && !channel && spell->GetCastTime() > 0)
            _casts.Finish(key, info->Id, "complete", now);
        else if (event == SpellEventType::Cancel)
            _casts.Finish(key, info->Id, bySelf ? "cancelled" : "interrupted", now);
    }

private:
    Json ReadCast(Unit* unit, Time now)
    {
        for (auto container : {CURRENT_GENERIC_SPELL, CURRENT_CHANNELED_SPELL})
        {
            bool channel = container == CURRENT_CHANNELED_SPELL;
            auto key = CastKey(unit, channel);
            Spell* spell = unit->GetCurrentSpell(container);
            if (spell && ((channel && spell->getState() == SPELL_STATE_CASTING) ||
                (!channel && spell->getState() == SPELL_STATE_PREPARING && spell->GetCastTime() > 0)))
            {
                auto info = spell->GetSpellInfo();
                if (channel && info->HasAttribute(SPELL_ATTR3_HIDE_CHANNEL_BAR))
                    continue;
                auto result = _casts.Read(key, info->Id, spell->GetCastTimeRemaining(), spell->GetCastTime(), now);
                if (result.is_null())
                {
                    // Recovery if capture began mid-cast or a bounded observation expired.
                    _casts.Start(key, info->Id, SpellName(info), channel,
                        channel ? spell->GetCastTimeRemaining() : spell->GetCastTime(), now);
                    result = _casts.Read(key, info->Id, spell->GetCastTimeRemaining(), spell->GetCastTime(), now);
                }
                return result;
            }
        }
        for (bool channel : {false, true})
        {
            auto terminal = _casts.Read(CastKey(unit, channel), 0, 0, 0, now);
            if (!terminal.is_null())
                return terminal;
        }
        return nullptr;
    }

    Json Frame(Unit* unit, Player* viewer, bool self, Time now)
    {
        Player* player = unit->ToPlayer();
        auto statuses = Json::array();
        if (!unit->IsAlive())
            statuses.push_back(player && player->HasPlayerFlag(PLAYER_FLAGS_GHOST) ? "ghost" : "dead");
        if (unit->IsInCombat())
            statuses.push_back("combat");
        if (unit->IsPvP())
            statuses.push_back("pvp");
        if (player && player->isAFK())
            statuses.push_back("afk");
        if (player && player->isDND())
            statuses.push_back("dnd");
        Json auras = Json::array();
        for (auto const& [slot, application] : *unit->GetVisibleAuras())
        {
            auto aura = application->GetBase();
            auto info = aura->GetSpellInfo();
            bool positive = application->IsPositive();
            if (!application->IsSelfcasted() && info->GetSpellSpecific() == SPELL_SPECIFIC_AURA)
                positive = false;
            auras.push_back(ProjectAura(info->Id, SpellName(info), slot, positive, info->StackAmount != 0,
                aura->GetStackAmount(), aura->GetCharges(), aura->GetMaxDuration(), aura->GetDuration(),
                info->HasAttribute(SPELL_ATTR5_DO_NOT_DISPLAY_DURATION)));
        }
        Json extra = {{"combo_points", 0}, {"mana", nullptr}, {"runes", Json::array()}};
        if (self && player)
        {
            extra["combo_points"] = player->GetComboPoints(player->GetTarget());
            if (player->getClass() == CLASS_DRUID && player->getPowerType() != POWER_MANA)
                extra["mana"] = Power(player, POWER_MANA);
            if (player->getClass() == CLASS_DEATH_KNIGHT)
                for (uint8 i = 0; i < MAX_RUNES; ++i)
                    extra["runes"].push_back({{"type", player->GetCurrentRune(i)},
                        {"base_type", player->GetBaseRune(i)}, {"remaining_ms", player->GetRuneCooldown(i)},
                        {"duration_ms", player->GetRuneBaseCooldown(i, true)}});
        }
        uint32 rank = 0;
        if (Creature* creature = unit->ToCreature())
            rank = creature->GetCreatureTemplate()->rank;
        return {{"guid", unit->GetGUID().ToString()}, {"name", unit->GetNameForLocaleIdx(LOCALE_enUS)},
            {"level", unit->GetLevel()}, {"class_id", player ? unit->getClass() : 0},
            {"kind", player ? "player" : "creature"}, {"creature_type", unit->GetCreatureType()}, {"rank", rank},
            {"reaction", unit->IsHostileTo(viewer) ? "hostile" : unit->IsFriendlyTo(viewer) ? "friendly" : "neutral"},
            {"health", {{"value", unit->GetHealth()}, {"max", unit->GetMaxHealth()}}},
            {"power", Power(unit, unit->getPowerType())}, {"statuses", std::move(statuses)},
            {"auras", std::move(auras)}, {"cast", ReadCast(unit, now)}, {"extra", std::move(extra)}};
    }

    std::unique_ptr<Sender> _sender;
    std::atomic<bool> _enabled{false};
    CastTracker _casts;
    uint32 _interval = 100;
    uint32 _elapsed = 0;
    std::uint64_t _sequence = 0;
    Time _nextError{};
};

class World final : public WorldScript
{
public:
    explicit World(std::shared_ptr<Service> service) : WorldScript("UnitWidgetWorld",
        {WORLDHOOK_ON_STARTUP, WORLDHOOK_ON_UPDATE, WORLDHOOK_ON_SHUTDOWN, WORLDHOOK_ON_AFTER_CONFIG_LOAD}),
        _service(std::move(service)) { }
    ~World() override { _service->Stop(); }
    void OnStartup() override { _service->Start(); }
    void OnUpdate(uint32 diff) override { _service->Update(diff); }
    void OnShutdown() override { _service->Stop(); }
    void OnAfterConfigLoad(bool reload) override
    {
        if (reload)
            LOG_INFO("module.unitwidget", "Unit widget settings are startup-only; restart to apply changes");
    }
private:
    std::shared_ptr<Service> _service;
};

class Players final : public PlayerScript
{
public:
    explicit Players(std::shared_ptr<Service> service) :
        PlayerScript("UnitWidgetPlayers", {PLAYERHOOK_ON_BEFORE_LOGOUT}), _service(std::move(service)) { }
    void OnPlayerBeforeLogout(Player* player) override { _service->Capture(player, "offline"); }
private:
    std::shared_ptr<Service> _service;
};

class Spells final : public AllSpellScript
{
public:
    explicit Spells(std::shared_ptr<Service> service) : AllSpellScript("UnitWidgetSpells",
        {ALLSPELLHOOK_ON_PREPARE, ALLSPELLHOOK_ON_CAST, ALLSPELLHOOK_ON_CAST_CANCEL}), _service(std::move(service)) { }
    void OnSpellPrepare(Spell* spell, Unit* caster, SpellInfo const* info) override
    {
        _service->SpellEvent(spell, caster, info, SpellEventType::Prepare);
    }
    void OnSpellCast(Spell* spell, Unit* caster, SpellInfo const* info, bool) override
    {
        _service->SpellEvent(spell, caster, info, SpellEventType::Cast);
    }
    void OnSpellCastCancel(Spell* spell, Unit* caster, SpellInfo const* info, bool bySelf) override
    {
        _service->SpellEvent(spell, caster, info, SpellEventType::Cancel, bySelf);
    }
private:
    std::shared_ptr<Service> _service;
};
}
}

void Addmod_unit_widgetScripts()
{
    auto service = std::make_shared<UnitWidget::Service>();
    new UnitWidget::World(service);
    new UnitWidget::Players(service);
    new UnitWidget::Spells(service);
}
