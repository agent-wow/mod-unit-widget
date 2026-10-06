// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_UNIT_WIDGET_STATE_H
#define MOD_UNIT_WIDGET_STATE_H

#include "../vendor/nlohmann/json.hpp"
#include <chrono>
#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace UnitWidget
{
using Json = nlohmann::json;
using Time = std::chrono::steady_clock::time_point;
using Milliseconds = std::chrono::milliseconds;
constexpr auto Freshness = Milliseconds(5000);

struct Response
{
    unsigned Status = 0;
    std::chrono::seconds RetryAfter{0};
};

bool Retryable(unsigned status);
double DisplayPower(std::uint8_t type, std::uint32_t value);
Json ProjectAura(std::uint32_t id, std::string const& name, std::uint8_t slot, bool positive,
    bool stackable, std::uint8_t stacks, std::uint8_t charges, int duration, int remaining, bool hideDuration);

struct Snapshot
{
    std::string Guid;
    std::uint64_t Sequence = 0;
    Time Captured;
    Json Data;
    std::size_t Bytes = 0;
};

// Replacements retain their place in the queue, preventing busy characters starving others.
class SnapshotQueue
{
public:
    explicit SnapshotQueue(std::size_t bytes = 16 * 1024 * 1024, std::size_t count = 10000);
    bool Push(Snapshot snapshot);
    std::vector<Snapshot> Take(Time now, std::size_t count = 100, std::size_t bytes = 512 * 1024);
    void Retry(std::vector<Snapshot> snapshots, Time now);
    std::size_t Size() const;

private:
    mutable std::mutex _mutex;
    std::list<Snapshot> _items;
    std::unordered_map<std::string, std::list<Snapshot>::iterator> _index;
    std::size_t _bytes = 0;
    std::size_t _maxBytes;
    std::size_t _maxCount;
};

Json Batch(std::string const& source, std::string const& process, std::vector<Snapshot> const& items, Time now);

// Scalar observations from map-thread spell hooks. No Spell/Unit references survive the hook.
struct Cast
{
    std::uint64_t Id = 0;
    std::uint32_t SpellId = 0;
    std::string Name;
    std::string State;
    int Duration = 0;
    int Remaining = 0;
    Time Observed;
};

class CastTracker
{
public:
    void Start(std::string const& key, std::uint32_t spell, std::string name, bool channel,
        int duration, Time now);
    void Finish(std::string const& key, std::uint32_t spell, std::string const& state, Time now);
    Json Read(std::string const& key, std::uint32_t activeSpell, int remaining, int duration, Time now);
    void Prune(Time now);

private:
    std::mutex _mutex;
    std::unordered_map<std::string, Cast> _casts;
    std::uint64_t _sequence = 0;
};
}

#endif
