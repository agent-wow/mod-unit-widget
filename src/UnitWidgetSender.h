// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_UNIT_WIDGET_SENDER_H
#define MOD_UNIT_WIDGET_SENDER_H

#include "UnitWidgetHttp.h"
#include <atomic>
#include <condition_variable>
#include <thread>

namespace UnitWidget
{
class Sender
{
public:
    Sender(HttpOptions options, std::string source, std::string process, std::size_t queueBytes);
    ~Sender();
    void Push(Snapshot snapshot);
    void Stop();

private:
    void Run();
    SnapshotQueue _queue;
    std::unique_ptr<Transport> _transport;
    std::string _source;
    std::string _process;
    std::atomic<bool> _stopping{false};
    std::atomic<std::int64_t> _deadline{0};
    std::mutex _mutex;
    std::condition_variable _wake;
    std::thread _worker;
};
}

#endif
