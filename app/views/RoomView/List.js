import React from 'react';
import { FlatList, InteractionManager, RefreshControl } from 'react-native';
import PropTypes from 'prop-types';
import orderBy from 'lodash/orderBy';
import { Q } from '@nozbe/watermelondb';
import moment from 'moment';
import isEqual from 'lodash/isEqual';

import styles from './styles';
import database from '../../lib/database';
import scrollPersistTaps from '../../utils/scrollPersistTaps';
import RocketChat from '../../lib/rocketchat';
import log from '../../utils/log';
import EmptyRoom from './EmptyRoom';
import { isIOS } from '../../utils/deviceInfo';
import { animateNextTransition } from '../../utils/layoutAnimation';
import ActivityIndicator from '../../containers/ActivityIndicator';
import debounce from '../../utils/debounce';
import { themes } from '../../constants/colors';

class List extends React.Component {
	static propTypes = {
		onEndReached: PropTypes.func,
		renderFooter: PropTypes.func,
		renderRow: PropTypes.func,
		rid: PropTypes.string,
		t: PropTypes.string,
		tmid: PropTypes.string,
		theme: PropTypes.string,
		listRef: PropTypes.func,
		hideSystemMessages: PropTypes.array,
		navigation: PropTypes.object
	};

	constructor(props) {
		super(props);
		console.time(`${ this.constructor.name } init`);
		console.time(`${ this.constructor.name } mount`);

		this.mounted = false;
		this.state = {
			loading: true,
			end: false,
			messages: [],
			refreshing: false,
			animated: false
		};
		this.init();
		this.didFocusListener = props.navigation.addListener('didFocus', () => {
			if (this.mounted) {
				this.setState({ animated: true });
			} else {
				this.state.animated = true;
			}
		});
		console.timeEnd(`${ this.constructor.name } init`);
	}

	componentDidMount() {
		this.mounted = true;
		console.timeEnd(`${ this.constructor.name } mount`);
	}

	// eslint-disable-next-line react/sort-comp
	async init() {
		const { rid, tmid } = this.props;
		const db = database.active;

		// handle servers with version < 3.0.0
		let { hideSystemMessages = [] } = this.props;
		if (!Array.isArray(hideSystemMessages)) {
			hideSystemMessages = [];
		}

		if (tmid) {
			try {
				this.thread = await db.collections
					.get('threads')
					.find(tmid);
			} catch (e) {
				console.log(e);
			}
			this.messagesObservable = db.collections
				.get('thread_messages')
				.query(Q.where('rid', tmid), Q.or(Q.where('t', Q.notIn(hideSystemMessages)), Q.where('t', Q.eq(null))))
				.observe();
		} else if (rid) {
			this.messagesObservable = db.collections
				.get('messages')
				.query(Q.where('rid', rid), Q.or(Q.where('t', Q.notIn(hideSystemMessages)), Q.where('t', Q.eq(null))))
				.observe();
		}

		if (rid) {
			this.unsubscribeMessages();
			this.messagesSubscription = this.messagesObservable
				.subscribe((data) => {
					this.interaction = InteractionManager.runAfterInteractions(() => {
						if (tmid) {
							data = [this.thread, ...data];
						}
						const messages = orderBy(data, ['ts'], ['desc']);
						if (this.mounted) {
							this.setState({ messages }, () => this.update());
						} else {
							this.state.messages = messages;
						}
					});
				});
		}
	}

	// eslint-disable-next-line react/sort-comp
	reload = () => {
		this.unsubscribeMessages();
		this.init();
	}

	// this.state.loading works for this.onEndReached and RoomView.init
	static getDerivedStateFromProps(props, state) {
		if (props.loading !== state.loading) {
			return {
				loading: props.loading
			};
		}
		return null;
	}

	shouldComponentUpdate(nextProps, nextState) {
		const { loading, end, refreshing } = this.state;
		const { hideSystemMessages, theme } = this.props;
		if (theme !== nextProps.theme) {
			return true;
		}
		if (loading !== nextState.loading) {
			return true;
		}
		if (end !== nextState.end) {
			return true;
		}
		if (refreshing !== nextState.refreshing) {
			return true;
		}
		if (!isEqual(hideSystemMessages, nextProps.hideSystemMessages)) {
			return true;
		}
		return false;
	}

	componentDidUpdate(prevProps) {
		const { hideSystemMessages } = this.props;
		if (!isEqual(hideSystemMessages, prevProps.hideSystemMessages)) {
			this.reload();
		}
	}

	componentWillUnmount() {
		this.unsubscribeMessages();
		if (this.interaction && this.interaction.cancel) {
			this.interaction.cancel();
		}
		if (this.onEndReached && this.onEndReached.stop) {
			this.onEndReached.stop();
		}
		if (this.didFocusListener && this.didFocusListener.remove) {
			this.didFocusListener.remove();
		}
		console.countReset(`${ this.constructor.name }.render calls`);
	}

	onEndReached = debounce(async() => {
		const {
			loading, end, messages
		} = this.state;
		if (loading || end || messages.length < 50) {
			return;
		}

		this.setState({ loading: true });
		const { rid, t, tmid } = this.props;
		try {
			let result;
			if (tmid) {
				// `offset` is `messages.length - 1` because we append thread start to `messages` obj
				result = await RocketChat.loadThreadMessages({ tmid, rid, offset: messages.length - 1 });
			} else {
				result = await RocketChat.loadMessagesForRoom({ rid, t, latest: messages[messages.length - 1].ts });
			}

			this.setState({ end: result.length < 50, loading: false });
		} catch (e) {
			this.setState({ loading: false });
			log(e);
		}
	}, 300)

	onRefresh = () => this.setState({ refreshing: true }, async() => {
		const { messages } = this.state;
		const { rid, tmid } = this.props;

		if (messages.length) {
			try {
				if (tmid) {
					await RocketChat.loadThreadMessages({ tmid, rid, offset: messages.length - 1 });
				} else {
					await RocketChat.loadMissedMessages({ rid, lastOpen: moment().subtract(7, 'days').toDate() });
				}
			} catch (e) {
				log(e);
			}
		}

		this.setState({ refreshing: false });
	})

	// eslint-disable-next-line react/sort-comp
	update = () => {
		const { animated } = this.state;
		if (animated) {
			animateNextTransition();
		}
		this.forceUpdate();
	};

	unsubscribeMessages = () => {
		if (this.messagesSubscription && this.messagesSubscription.unsubscribe) {
			this.messagesSubscription.unsubscribe();
		}
	}

	getLastMessage = () => {
		const { messages } = this.state;
		if (messages.length > 0) {
			return messages[0];
		}
		return null;
	}

	renderFooter = () => {
		const { loading } = this.state;
		const { rid, theme } = this.props;
		if (loading && rid) {
			return <ActivityIndicator theme={theme} />;
		}
		return null;
	}

	renderItem = ({ item, index }) => {
		const { messages } = this.state;
		const { renderRow } = this.props;
		return renderRow(item, messages[index + 1]);
	}

	render() {
		console.count(`${ this.constructor.name }.render calls`);
		const { rid, listRef } = this.props;
		const { messages, refreshing } = this.state;
		const { theme } = this.props;
		return (
			<>
				<EmptyRoom rid={rid} length={messages.length} mounted={this.mounted} theme={theme} />
				<FlatList
					testID='room-view-messages'
					ref={listRef}
					keyExtractor={item => item.id}
					data={messages}
					extraData={this.state}
					renderItem={this.renderItem}
					contentContainerStyle={styles.contentContainer}
					style={styles.list}
					inverted
					removeClippedSubviews={isIOS}
					initialNumToRender={7}
					onEndReached={this.onEndReached}
					onEndReachedThreshold={5}
					maxToRenderPerBatch={5}
					windowSize={10}
					ListFooterComponent={this.renderFooter}
					refreshControl={(
						<RefreshControl
							refreshing={refreshing}
							onRefresh={this.onRefresh}
							tintColor={themes[theme].auxiliaryText}
						/>
					)}
					{...scrollPersistTaps}
				/>
			</>
		);
	}
}

export default List;
