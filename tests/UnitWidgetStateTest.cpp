// SPDX-License-Identifier: GPL-2.0-or-later
#include "UnitWidgetState.h"
#include <gtest/gtest.h>

namespace
{
using namespace UnitWidget;
using namespace std::chrono_literals;

Snapshot MakeSnapshot(std::string guid, std::uint64_t sequence, Time now = Time{})
{
    return {guid, sequence, now, {{"guid", guid}, {"presence", "online"}}};
}

TEST(UnitWidgetState, WatchTargetClearingSurvivesRetryAndSerialization)
{
    SnapshotQueue queue;
    auto observed = MakeSnapshot("Observer", 1);
    observed.Data["watch_target"] = {{"guid", "Watched"}, {"name", "Watched"}};
    EXPECT_TRUE(queue.Push(observed));
    auto flight = queue.Take(Time{});
    auto published = Batch("realm", "process", flight, Time{});
    EXPECT_EQ(published["snapshots"][0]["watch_target"]["guid"], "Watched");
    observed.Sequence = 2;
    observed.Data["watch_target"] = nullptr;
    EXPECT_TRUE(queue.Push(observed));
    queue.Retry(std::move(flight), Time{} + 100ms);
    auto result = Batch("realm", "process", queue.Take(Time{} + 100ms), Time{} + 100ms);
    EXPECT_TRUE(result["snapshots"][0]["watch_target"].is_null());
    EXPECT_EQ(result["snapshots"][0]["sequence"], "2");
}

TEST(UnitWidgetState, NormalizesTenthsWithoutChangingOtherResources)
{
    EXPECT_DOUBLE_EQ(DisplayPower(1, 425), 42.5);
    EXPECT_DOUBLE_EQ(DisplayPower(6, 1000), 100);
    for (auto power : {0, 2, 3, 4})
        EXPECT_DOUBLE_EQ(DisplayPower(power, 1000), 1000);
}

TEST(UnitWidgetState, AuraVisibilityDurationAndStackChargeRules)
{
    auto stacked = ProjectAura(1, "Aura", 63, false, true, 3, 8, 10000, 4000, false);
    EXPECT_EQ(stacked["count"], 3);
    EXPECT_EQ(stacked["remaining_ms"], 4000);
    EXPECT_FALSE(stacked["positive"]);
    auto charges = ProjectAura(1, "Aura", 0, true, false, 1, 3, 10000, 4000, true);
    EXPECT_EQ(charges["count"], 3);
    EXPECT_TRUE(charges["duration_ms"].is_null());
    EXPECT_TRUE(charges["remaining_ms"].is_null());
    EXPECT_TRUE(ProjectAura(1, "Aura", 0, true, false, 1, 0, -1, -1, false)["duration_ms"].is_null());
}

TEST(UnitWidgetState, LatestSnapshotReplacesInPlaceWithoutStarvingOtherCharacters)
{
    SnapshotQueue queue;
    EXPECT_TRUE(queue.Push(MakeSnapshot("alice", 1)));
    EXPECT_TRUE(queue.Push(MakeSnapshot("bob", 2)));
    EXPECT_TRUE(queue.Push(MakeSnapshot("alice", 3)));
    EXPECT_FALSE(queue.Push(MakeSnapshot("alice", 1)));
    auto first = queue.Take(Time{}, 1);
    ASSERT_EQ(first.size(), 1);
    EXPECT_EQ(first[0].Guid, "alice");
    EXPECT_EQ(first[0].Sequence, 3);
    queue.Push(MakeSnapshot("alice", 4));
    EXPECT_EQ(queue.Take(Time{}, 1)[0].Guid, "bob");
}

TEST(UnitWidgetState, FailureRetryCannotReplaceNewStateAndExpiredFramesAreDropped)
{
    SnapshotQueue queue;
    queue.Push(MakeSnapshot("alice", 1));
    auto inFlight = queue.Take(Time{});
    queue.Push(MakeSnapshot("alice", 2, Time{} + 100ms));
    queue.Retry(std::move(inFlight), Time{} + 200ms);
    auto retry = queue.Take(Time{} + 200ms);
    ASSERT_EQ(retry.size(), 1);
    EXPECT_EQ(retry[0].Sequence, 2);
    queue.Retry(std::move(retry), Time{} + 6s);
    EXPECT_EQ(queue.Size(), 0);
    queue.Push(MakeSnapshot("old", 1));
    EXPECT_TRUE(queue.Take(Time{} + 5s).empty());
    EXPECT_TRUE(Retryable(0));
    EXPECT_TRUE(Retryable(429));
    EXPECT_TRUE(Retryable(503));
    EXPECT_FALSE(Retryable(401));
    EXPECT_FALSE(Retryable(302));
}

TEST(UnitWidgetState, EnforcesQueueBudgetAndEncodesExactSequenceWithCaptureAge)
{
    SnapshotQueue queue(1024, 1);
    queue.Push(MakeSnapshot("alice", 9007199254740993ULL));
    EXPECT_FALSE(queue.Push(MakeSnapshot("bob", 2)));
    auto data = Batch("realm-1", "process", queue.Take(Time{}), Time{} + 250ms);
    EXPECT_EQ(data["snapshots"][0]["sequence"], "9007199254740993");
    EXPECT_EQ(data["snapshots"][0]["age_ms"], 250);
    auto oversized = MakeSnapshot("bob", 3);
    oversized.Data["large"] = std::string(2048, 'x');
    EXPECT_FALSE(queue.Push(std::move(oversized)));
}

TEST(UnitWidgetState, RepeatedSpellsChannelsPushbackAndTerminalStates)
{
    CastTracker casts;
    casts.Start("alice/cast", 116, "Frostbolt", false, 3000, Time{});
    auto first = casts.Read("alice/cast", 116, 2800, 3000, Time{} + 200ms);
    EXPECT_EQ(first["remaining_ms"], 2800);
    casts.Finish("alice/cast", 116, "interrupted", Time{} + 300ms);
    EXPECT_EQ(casts.Read("alice/cast", 0, 0, 0, Time{} + 400ms)["state"], "interrupted");
    EXPECT_TRUE(casts.Read("alice/cast", 0, 0, 0, Time{} + 800ms).is_null());
    casts.Start("alice/cast", 116, "Frostbolt", false, 3000, Time{} + 1s);
    auto repeated = casts.Read("alice/cast", 116, 2900, 3000, Time{} + 1100ms);
    EXPECT_NE(repeated["id"], first["id"]);
    casts.Start("npc/channel", 15407, "Mind Flay", true, 5000, Time{});
    auto channel = casts.Read("npc/channel", 15407, 2000, 0, Time{} + 1s);
    EXPECT_EQ(channel["duration_ms"], 5000);
    EXPECT_EQ(channel["remaining_ms"], 2000);
    EXPECT_EQ(channel["state"], "channeling");
    casts.Start("instant", 1, "Instant", false, 0, Time{});
    EXPECT_TRUE(casts.Read("instant", 1, 0, 0, Time{}).is_null());
}
}
