// SPDX-License-Identifier: GPL-2.0-or-later
#include "UnitWidgetSender.h"
#include "Log.h"
#include <algorithm>

namespace UnitWidget
{
Sender::Sender(HttpOptions options, std::string source, std::string process, std::size_t queueBytes) :
    _queue(queueBytes), _transport(MakeHttpTransport(std::move(options))), _source(std::move(source)),
    _process(std::move(process)), _worker([this] { Run(); }) { }

Sender::~Sender() { Stop(); }

void Sender::Push(Snapshot snapshot)
{
    if (!_stopping.load())
        _queue.Push(std::move(snapshot));
    _wake.notify_one();
}

void Sender::Stop()
{
    if (!_worker.joinable())
        return;
    _deadline.store(std::chrono::duration_cast<Milliseconds>(
        (std::chrono::steady_clock::now() + std::chrono::seconds(2)).time_since_epoch()).count());
    _stopping.store(true);
    _wake.notify_one();
    _worker.join();
}

void Sender::Run()
{
    auto expired = [this]
    {
        return _stopping.load() && std::chrono::duration_cast<Milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count() >= _deadline.load();
    };
    auto nextAttempt = Time{};
    auto nextDiagnostic = Time{};
    unsigned backoff = 1;
    try
    {
        while (!expired())
        {
            auto now = std::chrono::steady_clock::now();
            if (_stopping.load() && !_queue.Size())
                break;
            if (now >= nextAttempt)
            {
                auto items = _queue.Take(now);
                if (!items.empty())
                {
                    auto response = _transport->Post(Batch(_source, _process, items, now).dump(), expired);
                    now = std::chrono::steady_clock::now();
                    if (response.Status >= 200 && response.Status < 300)
                    {
                        backoff = 1;
                        nextAttempt = now;
                    }
                    else
                    {
                        if (Retryable(response.Status))
                            _queue.Retry(std::move(items), now);
                        auto delay = std::max(std::chrono::seconds(backoff), response.RetryAfter);
                        nextAttempt = now + delay;
                        backoff = std::min(backoff * 2, 30u);
                        if (now >= nextDiagnostic)
                        {
                            LOG_WARN("module.unitwidget", "Unit widget delivery failed (HTTP {}); retry in {}s",
                                response.Status, delay.count());
                            nextDiagnostic = now + std::chrono::seconds(30);
                        }
                    }
                }
            }
            std::unique_lock lock(_mutex);
            _wake.wait_for(lock, Milliseconds(25));
        }
    }
    catch (std::exception const&)
    {
        LOG_ERROR("module.unitwidget", "Unit widget delivery worker stopped after an internal error");
    }
}
}
