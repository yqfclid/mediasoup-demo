let protooPort = 4444;

if (window.location.hostname === 'test.mediasoup.org')
	protooPort = 4444;

export function getProtooUrl({ roomId, peerId })
{
	const hostname = window.location.hostname;

	return `ws://127.0.0.1:4444/server-mediasoup?roomId=${roomId}&peerId=${peerId}`;
}
