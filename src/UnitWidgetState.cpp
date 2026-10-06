// SPDX-License-Identifier: GPL-2.0-or-later
#include "UnitWidgetState.h"
#include <algorithm>

namespace UnitWidget
{
bool Retryable(unsigned status)
{
    return !status || status == 408 || status == 429 || (status >= 500 && status < 600);
}

double DisplayPower(std::uint8_t type, std::uint32_t value)
{
    return value / ((type == 1 || type == 6) ? 10.0 : 1.0);
}

Json ProjectAura(std::uint32_t id, std::string const& name, std::uint8_t slot, bool positive,
    bool stackable, std::uint8_t stacks, std::uint8_t charges, int duration, int remaining, bool hideDuration)
{
    bool timed = duration > 0 && !hideDuration;
    return {{"spell_id", id}, {"name", name}, {"slot", slot}, {"positive", positive},
        {"count", stackable ? stacks : charges}, {"duration_ms", timed ? Json(duration) : Json(nullptr)},
        {"remaining_ms", timed ? Json(std::max(0, remaining)) : Json(nullptr)}};
}

SnapshotQueue::SnapshotQueue(std::size_t bytes, std::size_t count) : _maxBytes(bytes), _maxCount(count) { }

bool SnapshotQueue::Push(Snapshot snapshot)
{
    snapshot.Bytes = snapshot.Data.dump().size() + 256;
    if (snapshot.Bytes > _maxBytes || snapshot.Bytes > 128 * 1024)
        return false;
    std::lock_guard lock(_mutex);
    auto found = _index.find(snapshot.Guid);
    if (found != _index.end())
    {
        if (found->second->Sequence >= snapshot.Sequence)
            return false;
        if (_bytes - found->second->Bytes + snapshot.Bytes > _maxBytes)
            return false;
        _bytes -= found->second->Bytes;
        *found->second = std::move(snapshot);
        _bytes += found->second->Bytes;
        return true;
    }
    if (_items.size() >= _maxCount || _bytes + snapshot.Bytes > _maxBytes)
        return false;
    _bytes += snapshot.Bytes;
    _items.push_back(std::move(snapshot));
    _index.emplace(_items.back().Guid, std::prev(_items.end()));
    return true;
}

std::vector<Snapshot> SnapshotQueue::Take(Time now, std::size_t count, std::size_t bytes)
{
    std::vector<Snapshot> result;
    std::lock_guard lock(_mutex);
    std::size_t used = 1024;
    while (!_items.empty() && result.size() < count)
    {
        auto& item = _items.front();
        bool expired = now - item.Captured >= Freshness;
        if (!expired && used + item.Bytes > bytes)
            break;
        if (!expired)
            used += item.Bytes;
        _bytes -= item.Bytes;
        _index.erase(item.Guid);
        if (!expired)
            result.push_back(std::move(item));
        _items.pop_front();
    }
    return result;
}

void SnapshotQueue::Retry(std::vector<Snapshot> snapshots, Time now)
{
    for (auto& item : snapshots)
        if (now - item.Captured < Freshness)
            Push(std::move(item));
}

std::size_t SnapshotQueue::Size() const
{
    std::lock_guard lock(_mutex);
    return _items.size();
}

Json Batch(std::string const& source, std::string const& process, std::vector<Snapshot> const& items, Time now)
{
    Json snapshots = Json::array();
    for (auto const& item : items)
    {
        auto data = item.Data;
        data["sequence"] = std::to_string(item.Sequence);
        data["age_ms"] = std::max<std::int64_t>(0,
            std::chrono::duration_cast<Milliseconds>(now - item.Captured).count());
        snapshots.push_back(std::move(data));
    }
    return {{"schema_version", 1}, {"source_id", source}, {"process_id", process},
        {"snapshots", std::move(snapshots)}};
}

void CastTracker::Start(std::string const& key, std::uint32_t spell, std::string name, bool channel,
    int duration, Time now)
{
    if (!duration)
        return;
    std::lock_guard lock(_mutex);
    if (!_casts.contains(key) && _casts.size() >= 20000)
        return;
    _casts[key] = {++_sequence, spell, std::move(name), channel ? "channeling" : "casting",
        duration, duration, now};
}

void CastTracker::Finish(std::string const& key, std::uint32_t spell, std::string const& state, Time now)
{
    std::lock_guard lock(_mutex);
    auto it = _casts.find(key);
    if (it != _casts.end() && it->second.SpellId == spell)
    {
        it->second.State = state;
        it->second.Remaining = 0;
        it->second.Observed = now;
    }
}

Json CastTracker::Read(std::string const& key, std::uint32_t activeSpell, int remaining, int duration, Time now)
{
    std::lock_guard lock(_mutex);
    auto it = _casts.find(key);
    if (it == _casts.end())
        return nullptr;
    auto& cast = it->second;
    auto elapsed = std::chrono::duration_cast<Milliseconds>(now - cast.Observed).count();
    bool terminal = cast.State != "casting" && cast.State != "channeling";
    if (activeSpell != cast.SpellId)
    {
        if (!terminal || elapsed >= 500 || activeSpell)
            return nullptr;
    }
    else if (!terminal)
    {
        cast.Remaining = remaining;
        cast.Observed = now;
        // Preserve channel's original duration; the sampled timer tracks pushback/shortening.
        if (cast.State == "casting")
            cast.Duration = duration;
    }
    return {{"id", std::to_string(cast.Id)}, {"spell_id", cast.SpellId}, {"name", cast.Name},
        {"state", cast.State}, {"duration_ms", cast.Duration}, {"remaining_ms", cast.Remaining}};
}

void CastTracker::Prune(Time now)
{
    std::lock_guard lock(_mutex);
    std::erase_if(_casts, [now](auto const& entry)
    {
        return now - entry.second.Observed > Milliseconds(std::max(entry.second.Duration, 0)) + std::chrono::minutes(1);
    });
}
}
