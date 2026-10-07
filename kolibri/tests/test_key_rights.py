"""Live refuses a Kraken key that can withdraw (or whose rights cannot be proven)."""

import asyncio

from kolibri.adapters.kraken import withdraw_problems


class PermissionDenied(Exception):  # same class name ccxt raises for EGeneral:Permission denied
    pass


class Ex:
    def __init__(self, exc: Exception | None) -> None:
        self.exc = exc

    async def privatePostWithdrawMethods(self, params: dict[str, str]) -> list[object]:
        if self.exc:
            raise self.exc
        return []


def test_only_permission_denied_passes() -> None:
    assert asyncio.run(withdraw_problems(Ex(PermissionDenied("EGeneral:Permission denied")), "EUR")) == []
    assert "WITHDRAW" in asyncio.run(withdraw_problems(Ex(None), "EUR"))[0]
    assert "could not prove" in asyncio.run(withdraw_problems(Ex(TimeoutError()), "EUR"))[0]
